import { getSandbox } from "@cloudflare/sandbox";

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
import type { RuntimeEnv } from "./env.ts";
import { badRequest, forbidden, notFound, serviceUnavailable } from "./http.ts";
import type { User } from "./models.ts";
import {
  canControlOpenClawEmbeddedTerminalRequest,
  isOpenClawEmbedSessionToken,
} from "./openclaw-embed-access.ts";
import { SandboxLifecycleService } from "./provisioning/sandbox-lifecycle.ts";
import {
  readTerminalClipboardBytes,
  terminalClipboardFilename,
  terminalClipboardLimitMessage,
  terminalClipboardMaxBytes,
} from "./interactive-terminal.ts";
import { InteractiveTerminalRepository } from "./interactive-terminal-repository.ts";
import { reconcileSandboxCredentialPolicyCleanupBatch } from "./sandbox-credential-policy-cleanup-service.ts";
import { stageTerminalCredentialPolicyCleanupById } from "./sandbox-credential-policy-cleanup.ts";
import { isSandboxInteractiveSession, sandboxLeaseInfo } from "./sandbox-lease.ts";
import { openSandboxTerminalResponse, sandboxWorkdir } from "./sandbox-runtime.ts";
import {
  canControlInteractiveSession,
  delegatedInteractiveSessionControlAvailable,
} from "./session-access.ts";
import { githubActionsRelayStub } from "./session-control-do.ts";
import { appendInteractiveSessionEventRecord } from "./session-events.ts";
import type { InteractiveSession } from "./session-model.ts";
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
  private readonly repository: InteractiveTerminalRepository;

  constructor(env: RuntimeEnv, dependencies: InteractiveTerminalServiceDependencies) {
    this.env = env;
    this.dependencies = dependencies;
    this.repository = new InteractiveTerminalRepository(env);
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
            this.repository,
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
            this.repository,
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
        markInteractiveTerminalConnected(
          this.repository,
          this.env,
          user,
          session.id,
          now,
          "PTY terminal connected",
        ),
    };
  }

  async uploadClipboard(
    request: Request,
    user: User,
    sessionId: string,
  ): Promise<{ path: string; name: string; mediaType: string; byteCount: number }> {
    if (!(await canControlInteractiveSessionById(this.repository, this.env, user, sessionId))) {
      throw forbidden("terminal control has not been granted");
    }
    const session = await this.repository.readSession(sessionId);
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
      canOpenAnonymous: (request) =>
        canOpenAnonymousTerminalHub(request, this.env, this.repository),
      canViewShared: (request, sessionId) =>
        canViewSharedTerminalRequest(request, this.env, this.repository, sessionId),
      readSession: (sessionId) => this.dependencies.readFreshSession(sessionId),
      canViewSession: (request, user, session) =>
        canViewTerminalSession(request, this.env, this.repository, user, session),
      inputGrant: (request, user, session) =>
        terminalInputGrant(request, this.env, this.repository, user, session),
      viewGrant: (request, user, session) =>
        terminalViewGrant(request, this.env, this.repository, user, session),
      reconcileSubscription: (sessionId) =>
        terminalSubscriptionReconciler(this.dependencies, sessionId),
      openUpstream: (request, user, session, cols, rows) =>
        this.openUpstream(request, user, session, cols, rows),
      inputPayloads: (subscription, user, payload) =>
        multiplayerTerminalInputPayloads(this.repository, subscription, user, payload),
      markConnectionFailure: async (user, session, message) => {
        const markTerminal =
          session.runtime === githubActionsRuntime ||
          (isSandboxInteractiveSession(session) && this.env.SANDBOX)
            ? markInteractiveTerminalDetached
            : markInteractiveTerminalUnavailable;
        await markTerminal(this.repository, this.env, user, session.id, Date.now(), message);
      },
      markDetached: (user, sessionId, message) =>
        markInteractiveTerminalDetached(
          this.repository,
          this.env,
          user,
          sessionId,
          Date.now(),
          message,
        ),
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
  repository: InteractiveTerminalRepository,
  env: RuntimeEnv,
  user: User | null,
  sessionId: string,
  now: number,
  message: string,
): Promise<void> {
  const previous = await repository.readConnectionState(sessionId);
  await repository.markConnected(sessionId, message, now);
  if (
    previous &&
    (previous.status !== "attached" ||
      previous.lastEvent !== message ||
      now - previous.lastSeenAt > 5 * 60_000)
  ) {
    await appendTerminalLog(env, sessionId, user, message, now);
  }
}

async function markInteractiveTerminalDetached(
  repository: InteractiveTerminalRepository,
  env: RuntimeEnv,
  user: User | null,
  sessionId: string,
  now: number,
  message: string,
): Promise<void> {
  if (!(await repository.markDetached(sessionId, message))) return;
  await appendTerminalLog(env, sessionId, user, message, now);
}

async function markInteractiveTerminalUnavailable(
  repository: InteractiveTerminalRepository,
  env: RuntimeEnv,
  user: User | null,
  sessionId: string,
  now: number,
  message: string,
): Promise<void> {
  const existing = await repository.readSession(sessionId);
  if (!existing || ["expired", "failed", "stopped"].includes(existing.status)) return;
  if (terminalFailureStatusForAdapter(existing.adapter) === "detached") {
    if (existing.status === "stopping") return;
    await markInteractiveTerminalDetached(repository, env, user, sessionId, now, message);
    return;
  }
  if (
    isSandboxInteractiveSession({
      adapter: existing.adapter,
      leaseId: existing.leaseId,
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
  if (await repository.markExpired(existing, message, now)) {
    await appendTerminalLog(env, sessionId, user, message, now);
    await finalizeTerminalInteractiveSession(env, sessionId, "expired", now).catch(() => undefined);
  }
}

function terminalInputGrant(
  request: Request,
  env: RuntimeEnv,
  repository: InteractiveTerminalRepository,
  user: User | null,
  session: InteractiveSession,
): () => Promise<boolean> {
  if (!session.capabilities.terminal) return async () => false;
  return cachedBooleanGrant(() =>
    user
      ? canControlInteractiveSessionById(repository, env, user, session.id)
      : canControlOpenClawEmbeddedTerminalRequest(request, env, session.id),
  );
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
  repository: InteractiveTerminalRepository,
  user: User | null,
  session: InteractiveSession,
): () => Promise<boolean> {
  return async () =>
    Boolean(user && (await canControlInteractiveSessionById(repository, env, user, session.id))) ||
    (await canViewSharedTerminalRequest(request, env, repository, session.id));
}

async function canViewSharedTerminalRequest(
  request: Request,
  env: RuntimeEnv,
  repository: InteractiveTerminalRepository,
  sessionId: string,
): Promise<boolean> {
  const url = new URL(request.url);
  const shareSession = url.searchParams.get("shareSession") ?? "";
  const token = url.searchParams.get("token") ?? "";
  return (
    (!shareSession || shareSession === sessionId) &&
    (await isSharedSessionToken(env, repository, sessionId, token))
  );
}

async function canOpenAnonymousTerminalHub(
  request: Request,
  env: RuntimeEnv,
  repository: InteractiveTerminalRepository,
): Promise<boolean> {
  const url = new URL(request.url);
  const shareSession = url.searchParams.get("shareSession") ?? "";
  const token = url.searchParams.get("token") ?? "";
  return Boolean(
    shareSession && token && (await isSharedSessionToken(env, repository, shareSession, token)),
  );
}

async function canViewTerminalSession(
  request: Request,
  env: RuntimeEnv,
  repository: InteractiveTerminalRepository,
  user: User | null,
  session: InteractiveSession,
): Promise<boolean> {
  if (user) {
    requireRole(user, "viewer");
    if (await canControlInteractiveSessionById(repository, env, user, session.id)) return true;
  }
  return canViewSharedTerminalRequest(request, env, repository, session.id);
}

async function isSharedSessionToken(
  env: RuntimeEnv,
  repository: InteractiveTerminalRepository,
  sessionId: string,
  token: string,
): Promise<boolean> {
  if (!token) return false;
  if (await isOpenClawEmbedSessionToken(env, sessionId, token)) return true;
  const credential = await repository.readShareCredential(sessionId);
  return Boolean(
    credential?.tokenHash &&
    !["stopping", "expired", "failed", "stopped"].includes(credential.status) &&
    credential.terminalAvailable &&
    (await sha256(token)) === credential.tokenHash,
  );
}

async function canControlInteractiveSessionById(
  repository: InteractiveTerminalRepository,
  env: RuntimeEnv,
  user: User,
  sessionId: string,
): Promise<boolean> {
  const session = await repository.readSession(sessionId);
  if (!session) return false;
  if (!session.capabilities.terminal) return false;
  if (["stopping", "expired", "failed", "stopped"].includes(session.status)) return false;
  return canControlInteractiveSession(
    user,
    session,
    Date.now(),
    delegatedInteractiveSessionControlAvailable(Boolean(env.SANDBOX), session),
  );
}

async function multiplayerTerminalInputPayloads(
  repository: InteractiveTerminalRepository,
  subscription: TerminalHubSubscription,
  user: User | null,
  payload: Uint8Array,
): Promise<Uint8Array[]> {
  const submitted = terminalSubmittedLine(terminalInputState(subscription.session.id), payload);
  if (!user || !submitted || !submitted.text.trim()) return [payload];
  const enabled = await readInteractiveSessionMultiplayerMode(
    repository,
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
  repository: InteractiveTerminalRepository,
  sessionId: string,
  fallback: boolean,
): Promise<boolean> {
  try {
    return (await repository.readMultiplayerMode(sessionId)) ?? fallback;
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
