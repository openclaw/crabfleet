import { getSandbox } from "@cloudflare/sandbox";

import { cachedBooleanGrant } from "../../terminal-authorization.ts";
import { sanitizeTrustedProxyRequest } from "../../trusted-proxy-auth.ts";
import { clampedSeconds } from "../duration.ts";
import { database, type InteractiveSessionRow } from "../database.ts";
import { deploymentConfig, selectedRuntimeProfile } from "../deployment.ts";
import type { RuntimeEnv } from "../env.ts";
import {
  badRequest,
  conflict,
  notFound,
  readJson,
  serviceUnavailable,
  unauthorized,
} from "../http.ts";
import { normalizeRepo } from "../repositories.ts";
import {
  activeSandboxCredentialPolicyCondition,
  activeSandboxCredentialPolicyGeneration,
} from "../sandbox-credential-policy-repository.ts";
import { reconcileSandboxCredentialPolicyCleanupBatch } from "../sandbox-credential-policy-cleanup-service.ts";
import { isCurrentSandboxLease, sandboxLeaseInfo } from "../sandbox-lease.ts";
import { sandboxTerminalShellPath, terminalSize } from "../sandbox-runtime.ts";
import {
  interactiveCommand,
  interactiveSessionPurpose,
  interactiveSessionSummary,
} from "../session-create-request.ts";
import { bridgeWebSockets } from "../terminal-websocket-bridge.ts";
import {
  isManagedInteractiveSessionId,
  standaloneSandboxDefaultTtlSeconds,
} from "./standalone-sandbox.ts";
import { stageStandaloneSandboxProvisionCleanup } from "./standalone-sandbox-repository.ts";
import { failedProvision, safeProviderError } from "./result.ts";
import type {
  InteractiveProvisionRequest,
  InteractiveProvisionResult,
  InteractiveProvisionRuntime,
} from "./types.ts";

type StandaloneSandboxTerminalOwnership = {
  provisionId: string;
  requestHash: string;
  sandboxId: string;
  leaseId: string;
  expiresAt: number;
  updatedAt: number;
  policyGeneration: string;
};

export type InteractiveProvisioningEndpointDependencies = {
  provisionManaged(
    session: InteractiveProvisionRequest,
    owner: InteractiveSessionRow,
  ): Promise<InteractiveProvisionResult>;
  provisionStandalone(session: InteractiveProvisionRequest): Promise<InteractiveProvisionResult>;
  supportsStandalone(runtime: InteractiveProvisionRuntime): boolean;
};

export class InteractiveProvisioningEndpoints {
  private readonly env: RuntimeEnv;
  private readonly dependencies: InteractiveProvisioningEndpointDependencies;

  constructor(env: RuntimeEnv, dependencies: InteractiveProvisioningEndpointDependencies) {
    this.env = env;
    this.dependencies = dependencies;
  }

  async provision(request: Request): Promise<InteractiveProvisionResult> {
    this.authorize(request);
    const session = await readJson<Partial<InteractiveProvisionRequest>>(request);
    const id = clean(session.id, 120);
    const repo = normalizeRepo(session.repo);
    const branch = clean(session.branch, 120) || "main";
    const runtime = oneOf(session.runtime, ["crabbox", "container"], "container");
    const command = interactiveCommand(session.command);
    const { profile } = selectedRuntimeProfile(deploymentConfig(this.env), session.profile);
    const prompt = clean(session.prompt, 4000);
    const purpose = interactiveSessionPurpose(session.purpose, prompt, repo, branch, command);
    const summary = interactiveSessionSummary(session.summary, purpose, prompt);
    const owner = clean(session.owner, 240);
    const githubToken = clean(session.githubToken, 4000) || undefined;
    if (!id || !repo || !owner) {
      return failedProvision("interactive provision failed: invalid session request");
    }
    const payload: InteractiveProvisionRequest = {
      id,
      repo,
      branch,
      runtime,
      profile,
      command,
      prompt,
      purpose,
      summary,
      owner,
      createdBy: clean(session.createdBy, 240) || owner,
      parentSessionId: clean(session.parentSessionId, 120) || null,
      rootSessionId: clean(session.rootSessionId, 120) || id,
      ...(githubToken ? { githubToken } : {}),
    };
    const managed = await database(this.env)
      .selectFrom("interactive_sessions")
      .selectAll()
      .where("id", "=", payload.id)
      .executeTakeFirst();
    if (managed && managed.preparation_pending !== 0) {
      return failedProvision(
        "interactive provision failed: managed session preparation is pending",
      );
    }
    if (managed) {
      if (payload.runtime !== "container" || !this.env.SANDBOX) {
        return failedProvision(
          "interactive provision failed: managed session id is not available to this backend",
        );
      }
      return this.dependencies.provisionManaged(payload, managed);
    }
    if (this.dependencies.supportsStandalone(payload.runtime)) {
      return this.dependencies.provisionStandalone(payload);
    }
    return failedProvision(
      payload.runtime === "container"
        ? "interactive provision failed: Cloudflare Sandbox binding is not configured"
        : "interactive provision failed: standalone provision supports container runtime only",
    );
  }

  async stop(request: Request, provisionId: string): Promise<InteractiveProvisionResult> {
    this.authorize(request);
    const owner = await database(this.env)
      .selectFrom("standalone_sandbox_provisions")
      .selectAll()
      .where("id", "=", provisionId)
      .executeTakeFirst();
    if (!owner) throw notFound("standalone Sandbox provision not found");
    const now = Date.now();
    const staged = await stageStandaloneSandboxProvisionCleanup(
      this.env,
      owner,
      "standalone Sandbox stop requested",
      now,
    );
    if (!staged) throw conflict("standalone Sandbox ownership changed; retry stop");
    await reconcileSandboxCredentialPolicyCleanupBatch(this.env, now, provisionId);
    const remaining = await database(this.env)
      .selectFrom("standalone_sandbox_provisions")
      .select("state")
      .where("id", "=", provisionId)
      .executeTakeFirst();
    return {
      status: remaining ? "stopping" : "stopped",
      leaseId: null,
      attachUrl: null,
      vncUrl: null,
      expiresAt: null,
      expiresAtPresent: true,
      message: remaining ? "standalone Sandbox cleanup pending" : "standalone Sandbox stopped",
    };
  }

  async openPty(request: Request, provisionId: string): Promise<Response> {
    this.authorize(request);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw badRequest("websocket upgrade required");
    }
    if (!this.env.SANDBOX) throw serviceUnavailable("Sandbox binding is not configured");
    const owner = await database(this.env)
      .selectFrom("standalone_sandbox_provisions")
      .selectAll()
      .where("id", "=", provisionId)
      .where("state", "=", "active")
      .executeTakeFirst();
    if (
      !owner?.lease_id ||
      !isCurrentSandboxLease(owner.lease_id) ||
      !owner.expires_at ||
      owner.expires_at <= Date.now() ||
      isManagedInteractiveSessionId(provisionId)
    ) {
      if (owner) {
        const now = Date.now();
        await stageStandaloneSandboxProvisionCleanup(
          this.env,
          owner,
          isManagedInteractiveSessionId(provisionId)
            ? "standalone provision used the reserved managed session namespace"
            : "standalone Sandbox provision expired",
          now,
        );
        await reconcileSandboxCredentialPolicyCleanupBatch(this.env, now, provisionId);
      }
      throw notFound("standalone Sandbox provision not found");
    }
    const lease = sandboxLeaseInfo({ id: provisionId, leaseId: owner.lease_id });
    if (lease.sandboxId !== owner.sandbox_id) {
      throw serviceUnavailable("standalone Sandbox ownership is inconsistent");
    }
    const policyGeneration = await activeSandboxCredentialPolicyGeneration(
      this.env,
      provisionId,
      owner.sandbox_id,
    );
    if (!policyGeneration) {
      throw serviceUnavailable("standalone Sandbox credentials are unavailable");
    }
    const terminalOwnership: StandaloneSandboxTerminalOwnership = {
      provisionId,
      requestHash: owner.request_hash,
      sandboxId: owner.sandbox_id,
      leaseId: owner.lease_id,
      expiresAt: owner.expires_at,
      updatedAt: owner.updated_at,
      policyGeneration,
    };
    const terminalGrant = this.terminalGrant(terminalOwnership);
    if (!(await terminalGrant())) {
      throw serviceUnavailable("standalone Sandbox terminal authorization changed");
    }
    const sandbox = getSandbox(this.env.SANDBOX, owner.sandbox_id);
    let response: Response;
    try {
      const terminalSession = await sandbox.getSession(lease.terminalSessionId);
      const terminalHeaders = new Headers(sanitizeTrustedProxyRequest(request, this.env).headers);
      terminalHeaders.delete("authorization");
      terminalHeaders.delete("cookie");
      response = await terminalSession.terminal(
        new Request(request, { headers: terminalHeaders }),
        {
          cols: terminalSize(request, "cols", 120),
          rows: terminalSize(request, "rows", 34),
          shell: sandboxTerminalShellPath(provisionId),
        },
      );
    } catch (error) {
      throw serviceUnavailable(`standalone Sandbox terminal failed: ${safeProviderError(error)}`);
    }
    if (!response.webSocket || response.status !== 101) {
      throw serviceUnavailable(`standalone Sandbox terminal HTTP ${response.status}`);
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    response.webSocket.accept();
    bridgeWebSockets(server, response.webSocket, {
      canSendLeft: terminalGrant,
      deniedReason: "standalone Sandbox authorization revoked or expired",
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  private authorize(request: Request): void {
    if (!this.env.CRABBOX_INTERACTIVE_PROVISION_TOKEN) {
      throw serviceUnavailable("interactive provision token is not configured");
    }
    const expected = `Bearer ${this.env.CRABBOX_INTERACTIVE_PROVISION_TOKEN}`;
    if (request.headers.get("authorization") !== expected) throw unauthorized();
  }

  private terminalGrant(ownership: StandaloneSandboxTerminalOwnership): () => Promise<boolean> {
    return cachedBooleanGrant(async () => {
      const now = Date.now();
      const owner = await database(this.env)
        .selectFrom("standalone_sandbox_provisions")
        .select("id")
        .where("id", "=", ownership.provisionId)
        .where("request_hash", "=", ownership.requestHash)
        .where("sandbox_id", "=", ownership.sandboxId)
        .where("state", "=", "active")
        .where("lease_id", "=", ownership.leaseId)
        .where("expires_at", "=", ownership.expiresAt)
        .where("expires_at", ">", now)
        .where("updated_at", "=", ownership.updatedAt)
        .where(
          activeSandboxCredentialPolicyCondition(
            this.env,
            ownership.provisionId,
            ownership.sandboxId,
            ownership.policyGeneration,
            ownership.updatedAt,
          ),
        )
        .executeTakeFirst();
      return Boolean(owner);
    });
  }
}

export function standaloneSandboxAttachUrl(env: RuntimeEnv, provisionId: string): string {
  const url = new URL(
    `/api/provision/interactive/${encodeURIComponent(provisionId)}/pty`,
    deploymentConfig(env).canonicalUrl,
  );
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

export function standaloneSandboxProvisionTtlMs(env: RuntimeEnv): number {
  return (
    clampedSeconds(env.CRABBOX_STANDALONE_SANDBOX_TTL_SECONDS, standaloneSandboxDefaultTtlSeconds) *
    1000
  );
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}
