import { getSandbox } from "@cloudflare/sandbox";
import { sql } from "kysely";

import {
  attributedTerminalInputPayloads,
  newTerminalInputState,
  terminalSubmittedLine,
  type TerminalInputState,
} from "../terminal-multiplayer.ts";
import { githubActionsRuntime } from "../github-actions-runtime.ts";
import { terminalFailureStatusForAdapter } from "../runtime-adapter.ts";
import { cachedBooleanGrant } from "../terminal-authorization.ts";
import { actor, requireRole } from "./auth.ts";
import { base64FromBytes, sha256 } from "./crypto.ts";
import { database } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import { badRequest, forbidden, notFound, serviceUnavailable } from "./http.ts";
import type { User } from "./models.ts";
import { SandboxLifecycleService } from "./provisioning/sandbox-lifecycle.ts";
import {
  readTerminalClipboardBytes,
  terminalClipboardFilename,
  terminalClipboardLimitMessage,
  terminalClipboardMaxBytes,
} from "./interactive-terminal.ts";
import { reconcileSandboxCredentialPolicyCleanupBatch } from "./sandbox-credential-policy-cleanup-service.ts";
import { stageTerminalCredentialPolicyCleanupById } from "./sandbox-credential-policy-cleanup.ts";
import { isSandboxInteractiveSession, sandboxLeaseInfo } from "./sandbox-lease.ts";
import { openSandboxTerminalResponse, sandboxWorkdir } from "./sandbox-runtime.ts";
import { canControlInteractiveSession } from "./session-access.ts";
import { githubActionsRelayStub } from "./session-control-do.ts";
import { appendInteractiveSessionEventRecord } from "./session-events.ts";
import {
  interactiveSession,
  runtimeCapabilities,
  type InteractiveSession,
} from "./session-model.ts";
import { readInteractiveSessionRecord } from "./session-repository.ts";
import { finalizeTerminalInteractiveSession } from "./session-terminal-finalization.ts";
import {
  interactivePtyRouteKind,
  interactiveTerminalHeaders,
  interactiveTerminalTarget,
} from "./session-terminal-route.ts";
import {
  TerminalHub,
  type TerminalHubSubscription,
  type TerminalUpstream,
} from "./terminal-hub.ts";
import { interactiveTerminalFetch } from "./runtime-adapter-transport.ts";
import { terminalOutputAcknowledgements } from "./terminal-websocket-bridge.ts";

const terminalInputStates = new Map<string, TerminalInputState>();

export type InteractiveTerminalServiceDependencies = {
  readFreshSession(sessionId: string): Promise<InteractiveSession | null>;
  reconcileSession(sessionId: string, now: number): Promise<void>;
  reconcileIntervalMs: number;
  resolveSandboxSession(
    request: Request,
    user: User | null,
    session: InteractiveSession,
  ): Promise<InteractiveSession & { githubToken?: string }>;
};

export class InteractiveTerminalService {
  private readonly env: RuntimeEnv;
  private readonly dependencies: InteractiveTerminalServiceDependencies;

  constructor(env: RuntimeEnv, dependencies: InteractiveTerminalServiceDependencies) {
    this.env = env;
    this.dependencies = dependencies;
  }

  open(request: Request, user: User | null): Promise<Response> {
    return this.terminalHub().open(request, user);
  }

  async openUpstream(
    request: Request,
    user: User | null,
    session: InteractiveSession,
    cols: number,
    rows: number,
  ): Promise<TerminalUpstream> {
    if (!session.capabilities.terminal) {
      throw serviceUnavailable("session does not advertise terminal access");
    }
    const now = Date.now();
    if (session.runtime === githubActionsRuntime) {
      const stub = githubActionsRelayStub(this.env, session.id);
      if (!stub) throw serviceUnavailable("SESSION_CONTROL Durable Object is not configured");
      const upstreamResponse = await stub.fetch(
        "https://crabfleet.internal/api/session-control/github-actions/viewer",
        { headers: { upgrade: "websocket" } },
      );
      const upstream = upstreamResponse.webSocket;
      if (!upstream || upstreamResponse.status !== 101) {
        throw serviceUnavailable(`GitHub Actions relay HTTP ${upstreamResponse.status}`);
      }
      upstream.accept();
      return {
        socket: upstream,
        outputAcknowledgements: false,
        markConnected: () =>
          markInteractiveTerminalConnected(
            this.env,
            user,
            session.id,
            now,
            "GitHub Actions terminal connected",
          ),
      };
    }

    const routeKind = interactivePtyRouteKind(this.env, session);
    if (routeKind === "sandbox" && this.env.SANDBOX) {
      const runtimeSession = await this.dependencies.resolveSandboxSession(request, user, session);
      const sandboxSession = await new SandboxLifecycleService(this.env).ensureCurrentLease(
        request,
        user,
        runtimeSession,
      );
      const lease = sandboxLeaseInfo(sandboxSession);
      const sandbox = getSandbox(this.env.SANDBOX, lease.sandboxId);
      const upstreamResponse = await openSandboxTerminalResponse(
        request,
        this.env,
        sandbox,
        sandboxSession,
        { cols, rows },
      );
      const upstream = upstreamResponse.webSocket;
      if (!upstream || upstreamResponse.status !== 101) {
        throw serviceUnavailable(`Cloudflare Sandbox terminal HTTP ${upstreamResponse.status}`);
      }
      upstream.accept();
      return {
        socket: upstream,
        outputAcknowledgements: false,
        markConnected: () =>
          markInteractiveTerminalConnected(
            this.env,
            user,
            sandboxSession.id,
            now,
            "Cloudflare Sandbox terminal connected",
          ),
      };
    }

    const target = interactiveTerminalTarget(this.env, session, routeKind);
    if (!target) throw serviceUnavailable("terminal upstream is not configured for this session");
    const upstreamResponse = await interactiveTerminalFetch(
      this.env,
      session,
      target.url,
      interactiveTerminalHeaders(session, target.authorization),
    );
    const upstream = upstreamResponse.webSocket;
    if (!upstream || upstreamResponse.status !== 101) {
      throw serviceUnavailable(`terminal upstream HTTP ${upstreamResponse.status}`);
    }
    upstream.accept();
    return {
      socket: upstream,
      outputAcknowledgements: terminalOutputAcknowledgements(target.url),
      markConnected: () =>
        markInteractiveTerminalConnected(this.env, user, session.id, now, "PTY terminal connected"),
    };
  }

  async uploadClipboard(
    request: Request,
    user: User,
    sessionId: string,
  ): Promise<{ path: string; name: string; mediaType: string; byteCount: number }> {
    if (!(await canControlInteractiveSessionById(this.env, user, sessionId))) {
      throw forbidden("terminal control has not been granted");
    }
    const session = await readInteractiveSessionRecord(this.env, sessionId);
    if (!session) throw notFound("interactive session not found");
    if (["stopping", "expired", "failed", "stopped"].includes(session.status)) {
      throw badRequest(`session is ${session.status}`);
    }
    const bytes = await readTerminalClipboardBytes(request);
    return writeTerminalClipboardFile(
      this.env,
      user,
      session,
      bytes,
      decodedHeaderValue(request.headers.get("x-clipboard-name")),
      request.headers.get("content-type") || "application/octet-stream",
    );
  }

  private terminalHub(): TerminalHub {
    return new TerminalHub({
      createSocketPair: () => {
        const pair = new WebSocketPair();
        return { client: pair[0], server: pair[1] };
      },
      upgradeResponse: (client) => new Response(null, { status: 101, webSocket: client }),
      canOpenAnonymous: (request) => canOpenAnonymousTerminalHub(request, this.env),
      canViewShared: (request, sessionId) =>
        canViewSharedTerminalRequest(request, this.env, sessionId),
      readSession: (sessionId) => this.dependencies.readFreshSession(sessionId),
      canViewSession: (request, user, session) =>
        canViewTerminalSession(request, this.env, user, session),
      inputGrant: (user, session) => terminalInputGrant(this.env, user, session),
      viewGrant: (request, user, session) => terminalViewGrant(request, this.env, user, session),
      reconcileSubscription: (sessionId) =>
        terminalSubscriptionReconciler(this.dependencies, sessionId),
      openUpstream: (request, user, session, cols, rows) =>
        this.openUpstream(request, user, session, cols, rows),
      inputPayloads: (subscription, user, payload) =>
        multiplayerTerminalInputPayloads(this.env, subscription, user, payload),
      markConnectionFailure: async (user, session, message) => {
        const markTerminal =
          session.runtime === githubActionsRuntime ||
          (isSandboxInteractiveSession(session) && this.env.SANDBOX)
            ? markInteractiveTerminalDetached
            : markInteractiveTerminalUnavailable;
        await markTerminal(this.env, user, session.id, Date.now(), message);
      },
      markDetached: (user, sessionId, message) =>
        markInteractiveTerminalDetached(this.env, user, sessionId, Date.now(), message),
    });
  }
}

async function writeTerminalClipboardFile(
  env: RuntimeEnv,
  user: User,
  session: InteractiveSession,
  bytes: Uint8Array,
  rawName: unknown,
  rawMediaType: unknown,
): Promise<{ path: string; name: string; mediaType: string; byteCount: number }> {
  if (!isSandboxInteractiveSession(session) || !env.SANDBOX) {
    throw serviceUnavailable("clipboard file paste requires a Cloudflare Sandbox session");
  }
  if (!bytes.byteLength || bytes.byteLength > terminalClipboardMaxBytes) {
    throw badRequest(terminalClipboardLimitMessage());
  }
  const mediaType = clean(rawMediaType || "application/octet-stream", 120);
  const name = terminalClipboardFilename(rawName, mediaType);
  const lease = sandboxLeaseInfo(session);
  const sandbox = getSandbox(env.SANDBOX, lease.sandboxId);
  const directory = `${sandboxWorkdir(session.id)}/.crabbox/clipboard`;
  const path = `${directory}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${name}`;
  await sandbox.mkdir(directory, { recursive: true });
  await sandbox.writeFile(path, base64FromBytes(bytes), { encoding: "base64" });
  await appendTerminalEvent(env, session.id, user, `Clipboard file pasted: ${path}`, Date.now());
  return { path, name, mediaType, byteCount: bytes.byteLength };
}

async function markInteractiveTerminalConnected(
  env: RuntimeEnv,
  user: User | null,
  sessionId: string,
  now: number,
  message: string,
): Promise<void> {
  const previous = await database(env)
    .selectFrom("interactive_sessions")
    .select(["status", "last_event", "last_seen_at"])
    .where("id", "=", sessionId)
    .executeTakeFirst();
  await database(env)
    .updateTable("interactive_sessions")
    .set({
      status: "attached",
      last_seen_at: now,
      last_event: message,
    })
    .where("id", "=", sessionId)
    .where("status", "in", ["ready", "attached", "detached"])
    .execute();
  if (
    previous &&
    (previous.status !== "attached" ||
      previous.last_event !== message ||
      now - previous.last_seen_at > 5 * 60_000)
  ) {
    await appendTerminalLog(env, sessionId, user, message, now);
  }
}

async function markInteractiveTerminalDetached(
  env: RuntimeEnv,
  user: User | null,
  sessionId: string,
  now: number,
  message: string,
): Promise<void> {
  const existing = await database(env)
    .selectFrom("interactive_sessions")
    .select("status")
    .where("id", "=", sessionId)
    .executeTakeFirst();
  if (!existing || ["stopping", "expired", "failed", "stopped"].includes(existing.status)) return;
  await database(env)
    .updateTable("interactive_sessions")
    .set({
      status: "detached",
      last_event: message,
    })
    .where("id", "=", sessionId)
    .where("status", "in", ["ready", "attached", "detached"])
    .execute();
  await appendTerminalLog(env, sessionId, user, message, now);
}

async function markInteractiveTerminalUnavailable(
  env: RuntimeEnv,
  user: User | null,
  sessionId: string,
  now: number,
  message: string,
): Promise<void> {
  const existing = await database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("id", "=", sessionId)
    .executeTakeFirst();
  if (!existing || ["expired", "failed", "stopped"].includes(existing.status)) return;
  if (terminalFailureStatusForAdapter(existing.adapter) === "detached") {
    if (existing.status === "stopping") return;
    await markInteractiveTerminalDetached(env, user, sessionId, now, message);
    return;
  }
  if (
    isSandboxInteractiveSession({
      adapter: existing.adapter,
      leaseId: existing.lease_id,
    })
  ) {
    const staged = await stageTerminalCredentialPolicyCleanupById(
      env,
      sessionId,
      "failed",
      message,
      now,
      message,
    );
    if (!staged) return;
    await appendTerminalLog(env, sessionId, user, message, now);
    await reconcileSandboxCredentialPolicyCleanupBatch(env, now, sessionId);
    return;
  }
  if (existing.status === "stopping") return;
  const update = await database(env)
    .updateTable("interactive_sessions")
    .set({
      status: "expired",
      agent_token_hash: null,
      attach_url: null,
      vnc_url: null,
      controller: null,
      control_requested_by: null,
      control_requested_at: null,
      control_granted_at: null,
      control_expires_at: null,
      updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
      stopped_at: now,
      terminal_finalize_pending: 1,
      last_event: message,
    })
    .where("id", "=", sessionId)
    .where("status", "=", existing.status)
    .where("updated_at", "=", existing.updated_at)
    .executeTakeFirst();
  if ((update.numUpdatedRows ?? 0n) > 0n) {
    await appendTerminalLog(env, sessionId, user, message, now);
    await finalizeTerminalInteractiveSession(env, sessionId, "expired", now).catch(() => undefined);
  }
}

function terminalInputGrant(
  env: RuntimeEnv,
  user: User | null,
  session: InteractiveSession,
): () => Promise<boolean> {
  if (!user || !session.capabilities.terminal) return async () => false;
  return cachedBooleanGrant(() => canControlInteractiveSessionById(env, user, session.id));
}

function terminalSubscriptionReconciler(
  dependencies: InteractiveTerminalServiceDependencies,
  sessionId: string,
): () => void {
  let nextAt = Date.now() + dependencies.reconcileIntervalMs;
  let inFlight = false;
  return () => {
    const now = Date.now();
    if (inFlight || now < nextAt) return;
    inFlight = true;
    nextAt = now + dependencies.reconcileIntervalMs;
    void dependencies
      .reconcileSession(sessionId, now)
      .catch((error) => {
        console.error("terminal subscription reconciliation failed", error);
      })
      .finally(() => {
        inFlight = false;
      });
  };
}

function terminalViewGrant(
  request: Request,
  env: RuntimeEnv,
  user: User | null,
  session: InteractiveSession,
): () => Promise<boolean> {
  return async () =>
    Boolean(user && (await canControlInteractiveSessionById(env, user, session.id))) ||
    (await canViewSharedTerminalRequest(request, env, session.id));
}

async function canViewSharedTerminalRequest(
  request: Request,
  env: RuntimeEnv,
  sessionId: string,
): Promise<boolean> {
  const url = new URL(request.url);
  const shareSession = url.searchParams.get("shareSession") ?? "";
  const token = url.searchParams.get("token") ?? "";
  return (
    (!shareSession || shareSession === sessionId) &&
    (await isSharedSessionToken(env, sessionId, token))
  );
}

async function canOpenAnonymousTerminalHub(request: Request, env: RuntimeEnv): Promise<boolean> {
  const url = new URL(request.url);
  const shareSession = url.searchParams.get("shareSession") ?? "";
  const token = url.searchParams.get("token") ?? "";
  return Boolean(shareSession && token && (await isSharedSessionToken(env, shareSession, token)));
}

async function canViewTerminalSession(
  request: Request,
  env: RuntimeEnv,
  user: User | null,
  session: InteractiveSession,
): Promise<boolean> {
  if (user) {
    requireRole(user, "viewer");
    if (await canControlInteractiveSessionById(env, user, session.id)) return true;
  }
  return canViewSharedTerminalRequest(request, env, session.id);
}

async function isSharedSessionToken(
  env: RuntimeEnv,
  sessionId: string,
  token: string,
): Promise<boolean> {
  if (!token) return false;
  const row = await database(env)
    .selectFrom("interactive_sessions")
    .select(["share_token_hash", "share_mode", "status", "runtime", "capabilities_json"])
    .where("id", "=", sessionId)
    .where("share_mode", "=", "link_read")
    .executeTakeFirst();
  return Boolean(
    row?.share_token_hash &&
    !["stopping", "expired", "failed", "stopped"].includes(row.status) &&
    runtimeCapabilities(row.runtime, row.capabilities_json).terminal &&
    (await sha256(token)) === row.share_token_hash,
  );
}

async function canControlInteractiveSessionById(
  env: RuntimeEnv,
  user: User,
  sessionId: string,
): Promise<boolean> {
  const row = await database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("id", "=", sessionId)
    .executeTakeFirst();
  if (!row) return false;
  const session = interactiveSession(row, []);
  if (!session.capabilities.terminal) return false;
  if (["stopping", "expired", "failed", "stopped"].includes(session.status)) return false;
  return canControlInteractiveSession(
    user,
    session,
    Date.now(),
    delegatedControlAvailable(env, session),
  );
}

async function multiplayerTerminalInputPayloads(
  env: RuntimeEnv,
  subscription: TerminalHubSubscription,
  user: User | null,
  payload: Uint8Array,
): Promise<Uint8Array[]> {
  const submitted = terminalSubmittedLine(terminalInputState(subscription.session.id), payload);
  if (!user || !submitted || !submitted.text.trim()) return [payload];
  const enabled = await readInteractiveSessionMultiplayerMode(
    env,
    subscription.session.id,
    subscription.session.multiplayerMode,
  );
  return enabled ? attributedTerminalInputPayloads(user, submitted) : [payload];
}

function terminalInputState(sessionId: string): TerminalInputState {
  let state = terminalInputStates.get(sessionId);
  if (!state) {
    state = newTerminalInputState();
    terminalInputStates.set(sessionId, state);
  }
  return state;
}

async function readInteractiveSessionMultiplayerMode(
  env: RuntimeEnv,
  sessionId: string,
  fallback: boolean,
): Promise<boolean> {
  try {
    const row = await database(env)
      .selectFrom("interactive_sessions")
      .select("multiplayer_mode")
      .where("id", "=", sessionId)
      .executeTakeFirst();
    return row ? row.multiplayer_mode === 1 : fallback;
  } catch {
    return fallback;
  }
}

async function appendTerminalEvent(
  env: RuntimeEnv,
  sessionId: string,
  user: User,
  message: string,
  now: number,
): Promise<void> {
  await appendInteractiveSessionEventRecord(env, {
    sessionId,
    actor: actor(user),
    message,
    now,
  });
}

async function appendTerminalLog(
  env: RuntimeEnv,
  sessionId: string,
  user: User | null,
  message: string,
  now: number,
): Promise<void> {
  await appendInteractiveSessionEventRecord(env, {
    sessionId,
    actor: user ? actor(user) : "system",
    message,
    now,
  });
}

function delegatedControlAvailable(env: RuntimeEnv, session: InteractiveSession): boolean {
  return Boolean(env.SANDBOX || !isSandboxInteractiveSession(session));
}

function decodedHeaderValue(value: string | null): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
