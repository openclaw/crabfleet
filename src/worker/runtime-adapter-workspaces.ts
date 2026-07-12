import { sql } from "kysely";

import { githubActionsRuntime } from "../github-actions-runtime.ts";
import {
  adapterWorkspaceIdMatches,
  parseAdapterNativeVNCGrant,
  parseAdapterWorkspaceResult,
  redactedAdapterResponseMessage,
  runtimeAdapterCollectionUrl,
  runtimeAdapterName,
  runtimeAdapterNativeVNCUrl,
  runtimeAdapterReplayRequest,
  runtimeAdapterStopOutcome,
  runtimeAdapterWorkspaceIdConflict,
  runtimeAdapterWorkspaceUrl,
  shouldReplayRuntimeAdapterCreate,
  validatedRuntimeAdapterCreatePayloadJson,
  type AdapterProvisionRecord,
  type AdapterNativeVNCGrant,
} from "../runtime-adapter.ts";
import { database, type InteractiveSessionRow } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import {
  persistedRuntimeAdapterSeconds,
  runtimeAdapterProvisionResult,
  type RuntimeAdapterCreateAttemptFence,
  type RuntimeAdapterWorkspaceConflictInput,
} from "./provisioning/runtime-adapter.ts";
import type { RuntimeAdapterWorkspaceRegistration } from "./provisioning/runtime-adapter-release-service.ts";
import { safeProviderError } from "./provisioning/result.ts";
import type { InteractiveProvisionResult } from "./provisioning/types.ts";
import {
  configuredRuntimeAdapterControlPlane,
  requireRegisteredRuntimeAdapterControlPlane,
  runtimeAdapterToken,
} from "./runtime-adapter-preflight.ts";
import type { RuntimeAdapterWorkspaceStopResult } from "./session-runtime-adapter-stop.ts";

export type RuntimeAdapterWorkspaceLifecycleDependencies = {
  now(): number;
  fetch(input: string, init: RequestInit): Promise<Response>;
  readResponseBody(response: Response): Promise<unknown>;
  provisionReplay(
    session: AdapterProvisionRecord,
    owner: RuntimeAdapterCreateAttemptFence,
  ): Promise<InteractiveProvisionResult>;
  releaseFailed(
    sessionId: string,
    result: InteractiveProvisionResult,
  ): Promise<InteractiveProvisionResult>;
  failWorkspaceIdConflict(
    input: RuntimeAdapterWorkspaceConflictInput,
  ): Promise<InteractiveProvisionResult | null>;
  recordConfirmedRelease(
    sessionId: string,
    adapterWorkspaceId: string,
    now: number,
    message: string,
  ): Promise<void>;
  archive(sessionId: string, now: number): Promise<void>;
};

type StoppingRuntimeAdapterReplay = {
  message: string;
  resolved: boolean;
  terminalResult?: InteractiveProvisionResult;
};

export class RuntimeAdapterWorkspaceLifecycle {
  private readonly env: RuntimeEnv;
  private readonly dependencies: RuntimeAdapterWorkspaceLifecycleDependencies;

  constructor(env: RuntimeEnv, dependencies: RuntimeAdapterWorkspaceLifecycleDependencies) {
    this.env = env;
    this.dependencies = dependencies;
  }

  async createNativeVNCGrant(
    profile: string,
    registeredControlPlane: string | null,
    adapterWorkspaceId: string,
  ): Promise<AdapterNativeVNCGrant> {
    const controlPlane = requireRegisteredRuntimeAdapterControlPlane(
      this.env,
      profile,
      registeredControlPlane,
    );
    const response = await this.dependencies.fetch(
      runtimeAdapterNativeVNCUrl(controlPlane, adapterWorkspaceId),
      { method: "POST" },
    );
    const responseBody = await this.dependencies.readResponseBody(response);
    if (!response.ok) {
      throw new Error(
        redactedAdapterResponseMessage(
          responseBody,
          `runtime adapter native VNC HTTP ${response.status}`,
          [adapterWorkspaceId],
        ),
      );
    }
    const grant = parseAdapterNativeVNCGrant(responseBody, this.dependencies.now());
    if (!grant) throw new Error("runtime adapter returned an invalid native VNC grant");
    return grant;
  }

  async inspect(
    session: InteractiveSessionRow,
    reconciliationClaimAt: number,
  ): Promise<InteractiveProvisionResult> {
    const adapterWorkspaceId = session.adapter_workspace_id;
    const providerResourceId = session.provider_resource_id;
    if (!adapterWorkspaceId) {
      throw new Error("runtime adapter workspace reference is incomplete");
    }
    const controlPlane = requireRegisteredRuntimeAdapterControlPlane(
      this.env,
      session.profile,
      session.adapter_control_plane,
    );
    if (session.status === "stopping") {
      return this.reconcileStopping(session, reconciliationClaimAt);
    }
    if (shouldReplayRuntimeAdapterCreate(session.status, session.adapter_create_pending === 1)) {
      return this.dependencies.provisionReplay(runtimeAdapterRecord(session), {
        status: session.status,
        updatedAt: session.updated_at,
        lastReconciledAt: reconciliationClaimAt,
        terminalStatus: session.terminal_status,
      });
    }
    const response = await this.dependencies.fetch(
      runtimeAdapterWorkspaceUrl(controlPlane, adapterWorkspaceId),
      { method: "GET" },
    );
    const responseBody = await this.dependencies.readResponseBody(response);
    if (response.status === 404) {
      return {
        status: "expired",
        leaseId: null,
        attachUrl: null,
        attachUrlPresent: true,
        vncUrl: null,
        message: "runtime adapter workspace is gone",
        adapter: runtimeAdapterName,
        profile: session.profile,
        adapterWorkspaceId,
        providerResourceId,
        reconciledAt: this.dependencies.now(),
        reconcileError: null,
        createPending: false,
      };
    }
    if (!response.ok) {
      throw new Error(
        redactedAdapterResponseMessage(
          responseBody,
          `runtime adapter inspect HTTP ${response.status}`,
          [adapterWorkspaceId, providerResourceId],
        ),
      );
    }
    const parsed = parseAdapterWorkspaceResult(responseBody, {
      workspaceId: adapterWorkspaceId,
      providerResourceId,
      profile: session.profile,
    });
    if (!parsed) throw new Error("runtime adapter inspect returned an invalid workspace");
    if (!adapterWorkspaceIdMatches(parsed, adapterWorkspaceId)) {
      throw new Error("runtime adapter inspect returned a different workspace id");
    }
    if (parsed.profile !== session.profile) {
      throw new Error("runtime adapter inspect returned a different workspace profile");
    }
    const result = runtimeAdapterProvisionResult(
      parsed,
      runtimeAdapterRecord(session),
      this.dependencies.now(),
      adapterWorkspaceId,
      false,
    );
    return result.status === "failed"
      ? this.dependencies.releaseFailed(session.id, result)
      : result;
  }

  async stopForSession(
    sessionId: string,
    adapterWorkspaceId: string,
    retainedRegistration?: RuntimeAdapterWorkspaceRegistration | null,
    retainedCreatePending?: boolean,
  ): Promise<RuntimeAdapterWorkspaceStopResult> {
    const registration = retainedRegistration
      ? {
          adapter_control_plane: retainedRegistration.controlPlane,
          adapter_create_pending: retainedCreatePending ? 1 : 0,
          profile: retainedRegistration.profile,
        }
      : await database(this.env)
          .selectFrom("interactive_sessions")
          .select(["adapter_control_plane", "adapter_create_pending", "profile"])
          .where("id", "=", sessionId)
          .where("adapter", "=", runtimeAdapterName)
          .where("adapter_workspace_id", "=", adapterWorkspaceId)
          .executeTakeFirst();
    const controlPlane = requireRegisteredRuntimeAdapterControlPlane(
      this.env,
      registration?.profile ?? "",
      registration?.adapter_control_plane,
    );
    if (registration?.adapter_create_pending !== 0) {
      return {
        status: "stopping",
        message: "runtime adapter stop waiting for create resolution",
      };
    }
    return this.stopWorkspace(registration?.profile ?? "", controlPlane, adapterWorkspaceId);
  }

  private async reconcileStopping(
    session: InteractiveSessionRow,
    reconciliationClaimAt: number,
  ): Promise<InteractiveProvisionResult> {
    const adapterWorkspaceId = session.adapter_workspace_id;
    if (!adapterWorkspaceId) throw new Error("runtime adapter workspace reference is incomplete");

    let replayMessage: string | null = null;
    if (session.adapter_create_pending === 1) {
      const replay = await this.replayStoppingCreate(session, reconciliationClaimAt);
      replayMessage = replay.message;
      if (replay.terminalResult) return replay.terminalResult;
      if (!replay.resolved) {
        return {
          status: "stopping",
          leaseId: null,
          attachUrl: null,
          attachUrlPresent: true,
          vncUrl: null,
          message: replay.message,
          adapter: runtimeAdapterName,
          profile: session.profile,
          adapterWorkspaceId,
          providerResourceId: session.provider_resource_id,
          reconciledAt: this.dependencies.now(),
          reconcileError: replay.message,
          terminalStatus: session.terminal_status,
          createPending: true,
        };
      }
    }

    let release: RuntimeAdapterWorkspaceStopResult;
    try {
      release = await this.stopWorkspace(
        session.profile,
        requireRegisteredRuntimeAdapterControlPlane(
          this.env,
          session.profile,
          session.adapter_control_plane,
        ),
        adapterWorkspaceId,
      );
    } catch (error) {
      const message = `runtime adapter stop pending: ${safeProviderError(
        error,
        [adapterWorkspaceId, session.provider_resource_id],
        [session.attach_url],
      )}`;
      return {
        status: "stopping",
        leaseId: null,
        attachUrl: null,
        attachUrlPresent: true,
        vncUrl: null,
        message: replayMessage ? `${replayMessage}; ${message}` : message,
        adapter: runtimeAdapterName,
        profile: session.profile,
        adapterWorkspaceId,
        providerResourceId: session.provider_resource_id,
        reconciledAt: this.dependencies.now(),
        reconcileError: message,
        terminalStatus: session.terminal_status,
        createPending: session.adapter_create_pending === 1,
      };
    }
    if (release.status === "stopped") {
      await this.dependencies.recordConfirmedRelease(
        session.id,
        adapterWorkspaceId,
        this.dependencies.now(),
        release.message,
      );
    }
    const lifecycle = await database(this.env)
      .selectFrom("interactive_sessions")
      .select(["status", "terminal_status", "adapter_create_pending"])
      .where("id", "=", session.id)
      .where("adapter", "=", runtimeAdapterName)
      .where("adapter_workspace_id", "=", adapterWorkspaceId)
      .executeTakeFirst();
    const status = lifecycle?.status ?? (release.status === "stopped" ? "stopped" : "stopping");
    const createPending = lifecycle?.adapter_create_pending === 1;
    const releaseMessage = createPending
      ? `${release.message}; runtime adapter stop waiting for create resolution`
      : release.message;
    return {
      status,
      leaseId: null,
      attachUrl: null,
      attachUrlPresent: true,
      vncUrl: null,
      message: replayMessage ? `${replayMessage}; ${releaseMessage}` : releaseMessage,
      adapter: runtimeAdapterName,
      profile: session.profile,
      adapterWorkspaceId,
      providerResourceId: session.provider_resource_id,
      reconciledAt: this.dependencies.now(),
      reconcileError: null,
      terminalStatus: lifecycle?.terminal_status ?? null,
      createPending,
    };
  }

  private async replayStoppingCreate(
    session: InteractiveSessionRow,
    reconciliationClaimAt: number,
  ): Promise<StoppingRuntimeAdapterReplay> {
    const adapterWorkspaceId = session.adapter_workspace_id;
    const replay = runtimeAdapterReplayRequest(runtimeAdapterRecord(session));
    const requestedCapabilities = replay.adapterRequestedCapabilities;
    const ttlSeconds = persistedRuntimeAdapterSeconds(replay.adapterTtlSeconds);
    const idleTimeoutSeconds = persistedRuntimeAdapterSeconds(replay.adapterIdleTimeoutSeconds);
    if (
      !adapterWorkspaceId ||
      !requestedCapabilities ||
      !ttlSeconds ||
      !idleTimeoutSeconds ||
      !session.adapter_requested_capabilities_json
    ) {
      return {
        message: "runtime adapter create replay blocked: persisted lifecycle is incomplete",
        resolved: false,
      };
    }
    let controlPlane: string;
    try {
      controlPlane = requireRegisteredRuntimeAdapterControlPlane(
        this.env,
        session.profile,
        session.adapter_control_plane,
      );
    } catch (error) {
      return {
        message: safeProviderError(error, [adapterWorkspaceId]),
        resolved: false,
      };
    }
    const createPayloadJson = validatedRuntimeAdapterCreatePayloadJson(
      replay.adapterCreatePayloadJson ?? "",
      {
        workspaceId: adapterWorkspaceId,
        ttlSeconds,
        idleTimeoutSeconds,
        desktop: requestedCapabilities.desktop,
      },
    );
    if (!createPayloadJson) {
      return {
        message: "runtime adapter create replay blocked: persisted payload is invalid",
        resolved: false,
      };
    }
    let ownership = database(this.env)
      .selectFrom("interactive_sessions")
      .select("id")
      .where("id", "=", session.id)
      .where("adapter", "=", runtimeAdapterName)
      .where("adapter_workspace_id", "=", adapterWorkspaceId)
      .where("adapter_control_plane", "=", controlPlane)
      .where("adapter_create_payload_json", "=", createPayloadJson)
      .where(
        "adapter_requested_capabilities_json",
        "=",
        session.adapter_requested_capabilities_json,
      )
      .where("adapter_ttl_seconds", "=", ttlSeconds)
      .where("adapter_idle_timeout_seconds", "=", idleTimeoutSeconds)
      .where("adapter_create_pending", "=", 1)
      .where("status", "=", "stopping")
      .where("updated_at", "=", session.updated_at)
      .where("last_reconciled_at", "=", reconciliationClaimAt);
    ownership = session.terminal_status
      ? ownership.where("terminal_status", "=", session.terminal_status)
      : ownership.where("terminal_status", "is", null);
    if (!(await ownership.executeTakeFirst())) {
      return {
        message: "runtime adapter create replay deferred: lifecycle ownership changed",
        resolved: false,
      };
    }

    let response: Response;
    try {
      response = await this.dependencies.fetch(runtimeAdapterCollectionUrl(controlPlane), {
        method: "POST",
        headers: { "idempotency-key": adapterWorkspaceId },
        body: createPayloadJson,
      });
    } catch (error) {
      return {
        message: `runtime adapter create replay pending: ${safeProviderError(error, [adapterWorkspaceId])}`,
        resolved: false,
      };
    }

    let responseBody: unknown;
    try {
      responseBody = await this.dependencies.readResponseBody(response);
    } catch (error) {
      return {
        message: `runtime adapter create replay pending: ${safeProviderError(error, [adapterWorkspaceId])}`,
        resolved: false,
      };
    }
    if (!response.ok) {
      const responseMessage = redactedAdapterResponseMessage(
        responseBody,
        `HTTP ${response.status}`,
        [adapterWorkspaceId],
      );
      if (runtimeAdapterWorkspaceIdConflict(response.status, responseBody)) {
        const terminalResult = await this.dependencies.failWorkspaceIdConflict({
          session,
          now: this.dependencies.now(),
          adapterControlPlane: controlPlane,
          adapterWorkspaceId,
          createPayloadJson,
          capabilities: requestedCapabilities,
          createAttempt: {
            status: "stopping",
            updatedAt: session.updated_at,
            lastReconciledAt: reconciliationClaimAt,
            terminalStatus: session.terminal_status,
          },
          message: `runtime adapter create replay failed: ${responseMessage}`,
        });
        if (!terminalResult) {
          return {
            message: "runtime adapter create replay deferred: conflict response is stale",
            resolved: false,
          };
        }
        return { message: terminalResult.message, resolved: true, terminalResult };
      }
      return {
        message: `runtime adapter create replay pending: ${responseMessage}`,
        resolved: false,
      };
    }
    const parsed = parseAdapterWorkspaceResult(responseBody, {
      workspaceId: adapterWorkspaceId,
      profile: session.profile,
    });
    if (!parsed || !adapterWorkspaceIdMatches(parsed, adapterWorkspaceId)) {
      return {
        message: "runtime adapter create replay pending: invalid workspace identity",
        resolved: false,
      };
    }
    const message = `runtime adapter create replay resolved: ${parsed.status}`;

    const resolvedAt = this.dependencies.now();
    const terminalStatusOwner = session.terminal_status
      ? sql<boolean>`terminal_status = ${session.terminal_status}`
      : sql<boolean>`terminal_status IS NULL`;
    const expectedOwner = sql<boolean>`
      id = ${session.id}
      AND adapter = ${runtimeAdapterName}
      AND adapter_workspace_id = ${adapterWorkspaceId}
      AND adapter_control_plane = ${controlPlane}
      AND adapter_create_payload_json = ${createPayloadJson}
      AND adapter_requested_capabilities_json = ${session.adapter_requested_capabilities_json}
      AND adapter_ttl_seconds = ${ttlSeconds}
      AND adapter_idle_timeout_seconds = ${idleTimeoutSeconds}
      AND adapter_create_pending = 1
      AND status = 'stopping'
      AND updated_at = ${session.updated_at}
      AND last_reconciled_at = ${reconciliationClaimAt}
      AND ${terminalStatusOwner}
    `;
    const db = database(this.env);
    const update = db
      .updateTable("interactive_sessions")
      .set({
        adapter_create_pending: 0,
        last_reconciled_at: resolvedAt,
        reconcile_error: message,
        last_event: message,
        updated_at: sql<number>`MAX(updated_at + 1, ${resolvedAt})`,
      })
      .where(expectedOwner)
      .returning("updated_at");
    const event = sql`
      INSERT INTO interactive_session_events (session_id, actor, message, created_at)
      SELECT ${session.id}, 'system', ${clean(message, 1000)}, ${resolvedAt}
      FROM interactive_sessions
      WHERE ${expectedOwner}
    `;
    const results = await this.env.DB.batch<{ updated_at: number }>(
      [event, update].map((query) => {
        const compiled = query.compile(db);
        return this.env.DB.prepare(compiled.sql).bind(...compiled.parameters);
      }),
    );
    const resolved = Boolean(results.at(-1)?.results.length);
    if (resolved) {
      await this.dependencies.archive(session.id, resolvedAt).catch(() => undefined);
    }
    return { message, resolved };
  }

  private async stopWorkspace(
    profile: string,
    registeredControlPlane: string,
    adapterWorkspaceId: string,
  ): Promise<RuntimeAdapterWorkspaceStopResult> {
    const controlPlane = requireRegisteredRuntimeAdapterControlPlane(
      this.env,
      profile,
      registeredControlPlane,
    );
    const response = await this.dependencies.fetch(
      runtimeAdapterWorkspaceUrl(controlPlane, adapterWorkspaceId),
      { method: "DELETE" },
    );
    const body =
      response.status === 204 ? null : await this.dependencies.readResponseBody(response);
    const parsed = parseAdapterWorkspaceResult(body, { workspaceId: adapterWorkspaceId });
    if (parsed && !adapterWorkspaceIdMatches(parsed, adapterWorkspaceId)) {
      throw new Error("runtime adapter stop returned a different workspace id");
    }
    const fallbackMessage =
      response.status === 404 || response.status === 204
        ? "runtime adapter workspace released"
        : `runtime adapter stop HTTP ${response.status}`;
    const message =
      parsed?.message ??
      redactedAdapterResponseMessage(body, fallbackMessage, [adapterWorkspaceId]);
    if (response.status === 404 || response.status === 204) {
      return { status: "stopped", message };
    }
    if (!response.ok) throw new Error(message);
    const outcome = runtimeAdapterStopOutcome(response.status, parsed, adapterWorkspaceId);
    if (outcome === "identity_mismatch") {
      throw new Error("runtime adapter stop returned a different workspace id");
    }
    return { status: outcome, message };
  }
}

export function runtimeAdapterProviderConfigured(env: RuntimeEnv): boolean {
  return Boolean(
    configuredRuntimeAdapterControlPlane(env, "profile-route") && runtimeAdapterToken(env),
  );
}

function runtimeAdapterRecord(session: InteractiveSessionRow): AdapterProvisionRecord {
  if (session.runtime === githubActionsRuntime) {
    throw new Error("GitHub Actions sessions cannot use the runtime adapter");
  }
  return { ...session, runtime: session.runtime };
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
