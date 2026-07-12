import type { DirectoryBackup } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

import {
  credentialPolicyRegistrationAccepted,
  type CredentialPolicyGenerationTombstone,
} from "../credential-policy-fence.ts";
import type { FleetSandboxPolicySummary } from "../fleet-state.ts";
import {
  githubActionsRelayRole,
  notifyGitHubActionsViewers,
  relayGitHubActionsWebSocketMessage,
  replaceGitHubActionsRunner,
} from "../github-actions-runtime.ts";
import type { RuntimeEnv } from "./env.ts";
import { json } from "./http.ts";
import {
  dedupeSandboxPolicies,
  redactSandboxPolicy,
  sandboxCredentialPolicyCleanupDeletesStored,
  sandboxCredentialPolicyFromStorage,
  storedSandboxCredentialPolicy,
  validCredentialPolicyTombstone,
  validSandboxCredentialPolicyRegistration,
  type SandboxCredentialPolicy,
  type StoredSandboxCredentialPolicy,
} from "./session-control-policy.ts";

const sandboxControlObjectName = "__session-control";
const sandboxPolicyKey = (sandboxId: string) => `sandbox:${sandboxId}`;
const sandboxPolicyTombstoneKey = (sandboxId: string, generation: string) =>
  `sandbox-tombstone:${encodeURIComponent(sandboxId)}:${encodeURIComponent(generation)}`;
const sandboxCheckpointListKey = (sessionId: string) => `checkpoints:${sessionId}`;
const sandboxCheckpointKey = (sessionId: string, checkpointId: string) =>
  `checkpoint:${sessionId}:${checkpointId}`;

export type SandboxCheckpoint = {
  backup: DirectoryBackup;
  createdAt: number;
  id: string;
  name: string;
  sessionId: string;
  workdir: string;
};

export class SessionControlDO extends DurableObject<RuntimeEnv> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (
        request.method === "GET" &&
        url.pathname === "/api/session-control/github-actions/runner"
      ) {
        return this.openGitHubActionsRelay("runner");
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/session-control/github-actions/viewer"
      ) {
        return this.openGitHubActionsRelay("viewer");
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/session-control/github-actions/disconnect-runner"
      ) {
        const disconnected = replaceGitHubActionsRunner(
          this.ctx.getWebSockets("github-actions-runner"),
          1000,
          "runner disconnected",
        );
        return json({ disconnected });
      }

      if (request.method === "POST" && url.pathname === "/api/session-control/register") {
        const registration = (await request.json()) as StoredSandboxCredentialPolicy;
        if (!validSandboxCredentialPolicyRegistration(registration)) {
          return json({ error: "invalid credential policy registration" }, { status: 400 });
        }
        const outcome = await this.ctx.storage.transaction(async (transaction) => {
          const [stored, tombstone] = await Promise.all([
            transaction.get<unknown>(sandboxPolicyKey(registration.policy.sandboxId)),
            transaction.get<CredentialPolicyGenerationTombstone>(
              sandboxPolicyTombstoneKey(registration.policy.sandboxId, registration.generation),
            ),
          ]);
          const current = storedSandboxCredentialPolicy(stored);
          if (!credentialPolicyRegistrationAccepted(current, tombstone, registration, Date.now())) {
            return tombstone ? "tombstoned" : "conflict";
          }
          await transaction.put(sandboxPolicyKey(registration.policy.sandboxId), registration);
          return "stored";
        });
        if (outcome !== "stored") {
          return json({ error: `credential policy generation ${outcome}` }, { status: 409 });
        }
        return json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/api/session-control/policies") {
        const entries = await this.ctx.storage.list<unknown>({
          prefix: "sandbox:",
        });
        const policies = dedupeSandboxPolicies(
          [...entries.values()]
            .map((stored) => sandboxCredentialPolicyFromStorage(stored))
            .filter((policy): policy is SandboxCredentialPolicy => Boolean(policy)),
        ).map((policy) => redactSandboxPolicy(policy, Boolean(this.env.GITHUB_TOKEN)));
        return json({ policies });
      }

      const egressMatch = url.pathname.match(/^\/api\/session-control\/egress\/([^/]+)$/);
      if (request.method === "GET" && egressMatch) {
        const sandboxId = decodeURIComponent(egressMatch[1] ?? "");
        const key = sandboxPolicyKey(sandboxId);
        const stored = await this.ctx.storage.get<unknown>(key);
        const current = storedSandboxCredentialPolicy(stored);
        const policy = sandboxCredentialPolicyFromStorage(stored);
        if (!current || !policy) {
          return json({ error: "not found" }, { status: 404 });
        }
        return json(policy, {
          headers: { "x-crabfleet-policy-generation": current.generation },
        });
      }

      const sandboxMatch = url.pathname.match(/^\/api\/session-control\/sandbox\/([^/]+)$/);
      if (request.method === "DELETE" && sandboxMatch) {
        const sandboxId = decodeURIComponent(sandboxMatch[1] ?? "");
        const tombstone = (await request.json()) as CredentialPolicyGenerationTombstone;
        if (!validCredentialPolicyTombstone(tombstone)) {
          return json({ error: "invalid credential policy tombstone" }, { status: 400 });
        }
        await this.ctx.storage.transaction(async (transaction) => {
          const key = sandboxPolicyKey(sandboxId);
          const stored = await transaction.get<unknown>(key);
          await transaction.put(
            sandboxPolicyTombstoneKey(sandboxId, tombstone.generation),
            tombstone,
          );
          if (
            sandboxCredentialPolicyCleanupDeletesStored(
              stored,
              tombstone.generation,
              tombstone.sessionId,
            )
          ) {
            await transaction.delete(key);
          }
        });
        return json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/api/session-control/checkpoints") {
        const checkpoint = (await request.json()) as SandboxCheckpoint;
        await this.ctx.storage.put(
          sandboxCheckpointKey(checkpoint.sessionId, checkpoint.id),
          checkpoint,
        );
        const listKey = sandboxCheckpointListKey(checkpoint.sessionId);
        const list = (await this.ctx.storage.get<SandboxCheckpoint[]>(listKey)) ?? [];
        const next = [checkpoint, ...list.filter((item) => item.id !== checkpoint.id)].slice(0, 20);
        await this.ctx.storage.put(listKey, next);
        return json({ checkpoint });
      }

      const checkpointsMatch = url.pathname.match(/^\/api\/session-control\/checkpoints\/([^/]+)$/);
      if (request.method === "GET" && checkpointsMatch) {
        const sessionId = decodeURIComponent(checkpointsMatch[1] ?? "");
        const checkpoints =
          (await this.ctx.storage.get<SandboxCheckpoint[]>(sandboxCheckpointListKey(sessionId))) ??
          [];
        return json({ checkpoints });
      }

      const checkpointMatch = url.pathname.match(
        /^\/api\/session-control\/checkpoints\/([^/]+)\/([^/]+)$/,
      );
      if (request.method === "GET" && checkpointMatch) {
        const sessionId = decodeURIComponent(checkpointMatch[1] ?? "");
        const checkpointId = decodeURIComponent(checkpointMatch[2] ?? "");
        const checkpoint = await this.ctx.storage.get<SandboxCheckpoint>(
          sandboxCheckpointKey(sessionId, checkpointId),
        );
        return checkpoint ? json({ checkpoint }) : json({ error: "not found" }, { status: 404 });
      }
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
    return json({ error: "not found" }, { status: 404 });
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const role = githubActionsRelayRole(this.ctx.getTags(socket));
    if (!role) {
      socket.close(1008, "unknown relay peer");
      return;
    }
    relayGitHubActionsWebSocketMessage(
      role,
      socket,
      message,
      this.ctx.getWebSockets("github-actions-runner"),
      this.ctx.getWebSockets("github-actions-viewer"),
    );
  }

  override webSocketClose(socket: WebSocket): void {
    const role = githubActionsRelayRole(this.ctx.getTags(socket));
    if (role === "runner" && this.ctx.getWebSockets("github-actions-runner").length === 0) {
      notifyGitHubActionsViewers(
        this.ctx.getWebSockets("github-actions-viewer"),
        "runner_disconnected",
      );
    }
  }

  override webSocketError(socket: WebSocket): void {
    socket.close(1011, "relay peer error");
  }

  private openGitHubActionsRelay(role: "runner" | "viewer"): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (role === "runner") {
      replaceGitHubActionsRunner(this.ctx.getWebSockets("github-actions-runner"));
      this.ctx.acceptWebSocket(server, ["github-actions-runner"]);
      notifyGitHubActionsViewers(
        this.ctx.getWebSockets("github-actions-viewer"),
        "runner_connected",
      );
    } else {
      this.ctx.acceptWebSocket(server, ["github-actions-viewer"]);
      if (this.ctx.getWebSockets("github-actions-runner").length === 0) {
        notifyGitHubActionsViewers([server], "runner_waiting");
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }
}

export function sandboxControlStub(env: RuntimeEnv): DurableObjectStub<SessionControlDO> | null {
  if (!env.SESSION_CONTROL) return null;
  const id = env.SESSION_CONTROL.idFromName(sandboxControlObjectName);
  return env.SESSION_CONTROL.get(id);
}

export async function readSandboxFleetPolicies(env: RuntimeEnv): Promise<{
  available: boolean;
  policies: FleetSandboxPolicySummary[];
}> {
  const stub = sandboxControlStub(env);
  if (!stub) return { available: false, policies: [] };
  try {
    const response = await stub.fetch("https://crabfleet.internal/api/session-control/policies");
    if (!response.ok) return { available: false, policies: [] };
    const body = (await response.json()) as { policies?: FleetSandboxPolicySummary[] };
    return {
      available: true,
      policies: Array.isArray(body.policies) ? body.policies : [],
    };
  } catch {
    return { available: false, policies: [] };
  }
}
