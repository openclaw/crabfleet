import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  adapterFailureReleaseState,
  adapterWorkspaceIdMatches,
  clearedAdapterCapabilities,
  createOnlyAdapterStatus,
  definitiveRuntimeAdapterCreateFailure,
  effectiveAdapterCapabilities,
  currentAdapterDesktopConnection,
  legacyLeaseIdForAdapter,
  namespacedAdapterWorkspaceId,
  normalizeAdapterNamespace,
  normalizeAdapterWorkspaceId,
  parseAdapterDesktopConnection,
  parseAdapterWorkspaceResult,
  redactedAdapterMessage,
  redactedAdapterResponseMessage,
  runtimeAdapterControlPlaneForProfile,
  runtimeAdapterControlPlaneIdentity,
  runtimeAdapterCreatePayload,
  runtimeAdapterBrowserVncUrl,
  runtimeAdapterDesktopUrl,
  runtimeAdapterReplayRequest,
  retainedRuntimeAdapterFailureMessage,
  runtimeAdapterStopOutcome,
  runtimeAdapterTerminalFailureStatus,
  runtimeAdapterTerminalOriginMatches,
  runtimeAdapterWorkspaceIdConflict,
  runtimeAdapterWorkspaceUrl,
  resolveCreateAfterStopRace,
  safeDesktopUrl,
  safeWebSocketUrl,
  shouldReplayRuntimeAdapterCreate,
  validatedRuntimeAdapterCreatePayloadJson,
} from "../src/runtime-adapter.ts";

test("adapter create payload matches the strict controller contract", () => {
  const payload = runtimeAdapterCreatePayload({
    namespace: "fleet-a",
    id: "IS-101",
    parentSessionId: null,
    rootSessionId: "IS-101",
    repo: "example/project",
    branch: "main",
    runtime: "crabbox",
    profile: "default",
    command: "codex --yolo",
    prompt: "investigate the failure",
    purpose: "investigate",
    summary: "starting",
    owner: "operator",
    createdBy: "operator",
    ttlSeconds: 14_400,
    idleTimeoutSeconds: 1_800,
    desktop: true,
  });

  assert.deepEqual(payload, {
    id: "fleet-a-is-101",
    parentSessionId: null,
    rootSessionId: "IS-101",
    repo: "example/project",
    branch: "main",
    runtime: "crabbox",
    profile: "default",
    command: "codex --yolo",
    prompt: "investigate the failure",
    purpose: "investigate",
    summary: "starting",
    owner: "operator",
    createdBy: "operator",
    ttlSeconds: 14_400,
    idleTimeoutSeconds: 1_800,
    capabilities: { desktop: true },
  });
  assert.equal("apiVersion" in (payload ?? {}), false);
  assert.equal("sessionId" in (payload ?? {}), false);
  assert.equal("idempotencyKey" in (payload ?? {}), false);
  assert.equal(
    runtimeAdapterCreatePayload(
      {
        namespace: "different-config",
        id: "IS-101",
        parentSessionId: null,
        rootSessionId: "IS-101",
        repo: "example/project",
        branch: "main",
        runtime: "crabbox",
        profile: "default",
        command: "codex --yolo",
        prompt: "investigate the failure",
        purpose: "investigate",
        summary: "starting",
        owner: "operator",
        createdBy: "operator",
        ttlSeconds: 14_400,
        idleTimeoutSeconds: 1_800,
        desktop: true,
      },
      "fleet-a-is-101",
    )?.id,
    "fleet-a-is-101",
  );
});

test("configured profiles fence every adapter runtime and preserve requested capabilities", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const createStart = source.indexOf("async function createInteractiveSessionFromInput");
  const createEnd = source.indexOf("function initialRuntimeAdapterWorkspaceId", createStart);
  const createSource = source.slice(createStart, createEnd);
  const profileStart = source.indexOf("function selectedRuntimeProfile");
  const profileEnd = source.indexOf("function publicDeploymentConfig", profileStart);
  const profileSource = source.slice(profileStart, profileEnd);
  const resultStart = source.indexOf("function runtimeAdapterProvisionResult");
  const resultEnd = source.indexOf(
    "async function reconcileStoppingRuntimeAdapterWorkspace",
    resultStart,
  );
  const resultSource = source.slice(resultStart, resultEnd);

  assert.match(createSource, /selectedRuntimeProfile\(deployment, body\.profile\)/);
  assert.match(profileSource, /deployment\.runtimeProfiles\.length > 0 && !descriptor/);
  assert.match(resultSource, /session\.adapterRequestedCapabilities \?\?/);
  assert.match(resultSource, /profile: session\.profile/);
  assert.doesNotMatch(resultSource, /profile: result\.profile/);
});

test("profile-routed adapter responses cannot rewrite their lifecycle route", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const createStart = source.indexOf("async function provisionWithRuntimeAdapter");
  const createEnd = source.indexOf("function persistedRuntimeAdapterSeconds", createStart);
  const createSource = source.slice(createStart, createEnd);
  const inspectStart = source.indexOf("async function inspectRuntimeAdapterWorkspace");
  const inspectEnd = source.indexOf(
    "async function reconcileStoppingRuntimeAdapterWorkspace",
    inspectStart,
  );
  const inspectSource = source.slice(inspectStart, inspectEnd);

  assert.match(createSource, /parsed\.profile !== session\.profile/);
  assert.match(createSource, /workspace profile mismatch/);
  assert.match(inspectSource, /parsed\.profile !== session\.profile/);
  assert.match(inspectSource, /different workspace profile/);
});

test("adapter workspace id stays distinct from provider resource id", () => {
  const result = parseAdapterWorkspaceResult({
    id: "fleet-a-is-101",
    providerResourceId: "cloud/project/box-42",
    status: "ready",
    attachUrl: "wss://controller.example/terminal/is-101",
    capabilities: {
      terminal: true,
      takeover: false,
      vnc: true,
      desktop: true,
      logs: false,
      artifacts: false,
      browser: true,
      code: true,
    },
    expiresAt: "2026-06-12T12:00:00Z",
    message: "cloud/project/box-42 is ready as fleet-a-is-101",
  });

  assert.equal(result?.workspaceId, "fleet-a-is-101");
  assert.equal(result?.providerResourceId, "cloud/project/box-42");
  assert.equal(result?.terminalUrl, "wss://controller.example/terminal/is-101");
  assert.equal(result?.terminalUrlPresent, true);
  assert.equal(result?.capabilities?.terminal, true);
  assert.equal(result?.capabilities?.desktop, true);
  assert.equal(result?.capabilities?.vnc, true);
  assert.equal(result?.terminalCapabilityInferred, false);
  assert.equal(result?.message, "[workspace] is ready as [workspace]");
  assert.deepEqual(
    effectiveAdapterCapabilities(
      result!,
      {
        ...clearedAdapterCapabilities,
        takeover: true,
        logs: true,
        artifacts: true,
      },
      false,
    ),
    {
      terminal: true,
      takeover: false,
      vnc: true,
      desktop: true,
      logs: false,
      artifacts: false,
    },
  );

  const explicitlyDisabled = parseAdapterWorkspaceResult({
    id: "fleet-a-is-102",
    status: "ready",
    attachUrl: "wss://controller.example/terminal/is-102",
    capabilities: { terminal: false, desktop: true },
  });
  assert.equal(explicitlyDisabled?.capabilities?.terminal, false);
  assert.equal(explicitlyDisabled?.terminalCapabilityInferred, false);
  assert.equal(
    effectiveAdapterCapabilities(
      explicitlyDisabled!,
      { ...clearedAdapterCapabilities, terminal: true, takeover: true, artifacts: true },
      true,
    )?.terminal,
    false,
  );

  const explicitlyNull = parseAdapterWorkspaceResult({
    id: "fleet-a-is-102-null",
    status: "ready",
    attachUrl: "wss://controller.example/terminal/is-102-null",
    capabilities: { terminal: null, desktop: true },
  });
  assert.equal(explicitlyNull?.capabilities?.terminal, false);
  assert.equal(explicitlyNull?.terminalCapabilityInferred, false);
  assert.equal(
    effectiveAdapterCapabilities(
      explicitlyNull!,
      { ...clearedAdapterCapabilities, terminal: true, artifacts: true },
      false,
    )?.terminal,
    false,
  );

  const authoritativeList = parseAdapterWorkspaceResult({
    id: "fleet-a-is-103",
    status: "ready",
    attachUrl: "wss://controller.example/terminal/is-103",
    capabilities: ["desktop"],
  });
  assert.equal(authoritativeList?.capabilities?.terminal, false);
  assert.equal(authoritativeList?.terminalCapabilityInferred, false);

  const omittedCapabilities = parseAdapterWorkspaceResult({
    id: "fleet-a-is-104",
    status: "ready",
    attachUrl: "wss://controller.example/terminal/is-104",
  });
  assert.equal(omittedCapabilities?.capabilitiesPresent, false);
  assert.equal(omittedCapabilities?.terminalCapabilityInferred, true);
  assert.equal(omittedCapabilities?.capabilities, null);
  assert.deepEqual(
    effectiveAdapterCapabilities(
      omittedCapabilities!,
      { ...clearedAdapterCapabilities, desktop: true, vnc: true, logs: true, artifacts: true },
      false,
    ),
    {
      ...clearedAdapterCapabilities,
      terminal: true,
      desktop: true,
      vnc: true,
      logs: true,
      artifacts: true,
    },
  );

  const overlapping = parseAdapterWorkspaceResult({
    id: "fleet-a-is-101",
    providerResourceId: "fleet-a-is-101-provider-suffix",
    status: "ready",
    message: "fleet-a-is-101-provider-suffix is ready for fleet-a-is-101",
  });
  assert.equal(overlapping?.message, "[workspace] is ready for [workspace]");
});

test("adapter workspace identity is namespaced, bounded, and exact", () => {
  assert.equal(normalizeAdapterNamespace("Fleet-A"), "fleet-a");
  assert.equal(normalizeAdapterNamespace("fleet_a"), null);
  assert.equal(namespacedAdapterWorkspaceId("Fleet-A", "IS-101"), "fleet-a-is-101");
  assert.equal(namespacedAdapterWorkspaceId("a".repeat(32), "b".repeat(31)), null);

  const exact = parseAdapterWorkspaceResult({ id: "fleet-a-is-101", status: "ready" });
  const wrong = parseAdapterWorkspaceResult({ id: "fleet-b-is-101", status: "ready" });
  const missing = parseAdapterWorkspaceResult(
    { status: "ready" },
    { workspaceId: "fleet-a-is-101" },
  );
  assert.equal(adapterWorkspaceIdMatches(exact!, "fleet-a-is-101"), true);
  assert.equal(adapterWorkspaceIdMatches(wrong!, "fleet-a-is-101"), false);
  assert.equal(adapterWorkspaceIdMatches(missing!, "fleet-a-is-101"), false);
  assert.equal(exact?.providerResourceId, null);
  assert.equal(parseAdapterWorkspaceResult({ id: " fleet-a-is-101", status: "ready" }), null);
  assert.equal(parseAdapterWorkspaceResult({ id: "Fleet-A-Is-101", status: "ready" }), null);
  assert.equal(
    parseAdapterWorkspaceResult({
      id: "fleet-a-is-101",
      workspaceId: "fleet-a-is-102",
      status: "ready",
    }),
    null,
  );
});

test("create-only adapters cannot return an unowned stopping lifecycle", () => {
  assert.equal(createOnlyAdapterStatus("ready"), "ready");
  assert.equal(createOnlyAdapterStatus("failed"), "failed");
  assert.equal(createOnlyAdapterStatus("stopping"), null);
  assert.equal(createOnlyAdapterStatus(" ready "), null);
});

test("status-only inspect preserves omitted capability and expiry fields", () => {
  const omitted = parseAdapterWorkspaceResult({ id: "fleet-a-is-101", status: "ready" });
  assert.equal(omitted?.capabilitiesPresent, false);
  assert.equal(omitted?.capabilities, null);
  assert.equal(omitted?.expiresAtPresent, false);
  assert.equal(omitted?.expiresAt, null);
  assert.equal(omitted?.terminalUrlPresent, false);

  const cleared = parseAdapterWorkspaceResult({
    id: "fleet-a-is-101",
    status: "ready",
    capabilities: null,
    expiresAt: null,
    attachUrl: null,
  });
  assert.equal(cleared?.capabilitiesPresent, true);
  assert.equal(cleared?.capabilities, null);
  assert.equal(cleared?.expiresAtPresent, true);
  assert.equal(cleared?.expiresAt, null);
  assert.equal(cleared?.terminalUrlPresent, true);
  assert.equal(cleared?.terminalUrl, null);
  assert.equal(
    parseAdapterWorkspaceResult({
      id: "fleet-a-is-101",
      status: "ready",
      expiresAt: "not-a-date",
    }),
    null,
  );
  assert.equal(
    parseAdapterWorkspaceResult({
      id: "fleet-a-is-101",
      status: "ready",
      expiresAt: "",
    }),
    null,
  );
  assert.deepEqual(clearedAdapterCapabilities, {
    terminal: false,
    takeover: false,
    vnc: false,
    desktop: false,
    logs: false,
    artifacts: false,
  });
  assert.deepEqual(
    effectiveAdapterCapabilities(
      cleared!,
      { ...clearedAdapterCapabilities, vnc: true, desktop: true },
      true,
    ),
    clearedAdapterCapabilities,
  );
  assert.equal(
    effectiveAdapterCapabilities(omitted!, clearedAdapterCapabilities, false),
    undefined,
  );
});

test("missing ambiguous workspaces replay the complete persisted request", () => {
  const createPayloadJson = JSON.stringify({
    id: "fleet-a-is-101",
    purpose: "immutable original purpose",
    summary: "immutable original summary",
    profile: "desktop-large",
    ttlSeconds: 14_400,
    idleTimeoutSeconds: 1_800,
    capabilities: { desktop: true },
  });
  const request = runtimeAdapterReplayRequest({
    id: "IS-101",
    adapter_workspace_id: "fleet-a-is-101",
    adapter_control_plane: "https://controller.example/api",
    parent_session_id: "IS-100",
    root_session_id: "IS-99",
    repo: "example/project",
    branch: "feature/retry",
    runtime: "crabbox",
    profile: "desktop-large",
    command: "codex --yolo",
    prompt: "continue after timeout",
    purpose: "repair create",
    summary: "create outcome unknown",
    owner: "operator",
    created_by: "service",
    adapter_ttl_seconds: 14_400,
    adapter_idle_timeout_seconds: 1_800,
    adapter_requested_capabilities_json: JSON.stringify({
      terminal: true,
      takeover: true,
      vnc: true,
      desktop: true,
      logs: true,
      artifacts: true,
    }),
    adapter_create_payload_json: createPayloadJson,
  });

  assert.deepEqual(request, {
    id: "IS-101",
    adapterWorkspaceId: "fleet-a-is-101",
    adapterControlPlane: "https://controller.example/api",
    parentSessionId: "IS-100",
    rootSessionId: "IS-99",
    repo: "example/project",
    branch: "feature/retry",
    runtime: "crabbox",
    profile: "desktop-large",
    command: "codex --yolo",
    prompt: "continue after timeout",
    purpose: "repair create",
    summary: "create outcome unknown",
    owner: "operator",
    createdBy: "service",
    adapterTtlSeconds: 14_400,
    adapterIdleTimeoutSeconds: 1_800,
    adapterRequestedCapabilities: {
      terminal: true,
      takeover: true,
      vnc: true,
      desktop: true,
      logs: true,
      artifacts: true,
    },
    adapterCreatePayloadJson: createPayloadJson,
  });
  assert.equal(shouldReplayRuntimeAdapterCreate("provisioning", true), true);
  assert.equal(shouldReplayRuntimeAdapterCreate("pending_adapter", true), true);
  assert.equal(shouldReplayRuntimeAdapterCreate("provisioning", false), false);
  assert.equal(shouldReplayRuntimeAdapterCreate("ready", true), false);
  assert.equal(shouldReplayRuntimeAdapterCreate("stopping", true), false);
  assert.equal(
    validatedRuntimeAdapterCreatePayloadJson(createPayloadJson, {
      workspaceId: "fleet-a-is-101",
      ttlSeconds: 14_400,
      idleTimeoutSeconds: 1_800,
      desktop: true,
    }),
    createPayloadJson,
  );
});

test("failed adapter workspaces become terminal only after release", () => {
  assert.deepEqual(adapterFailureReleaseState("stopping"), {
    status: "stopping",
    terminalStatus: "failed",
    message: "runtime workspace release pending",
  });
  assert.deepEqual(adapterFailureReleaseState("stopped"), {
    status: "failed",
    terminalStatus: null,
    message: "runtime workspace released",
  });
});

test("adapter failure release retains the actual failure reason", () => {
  assert.equal(
    retainedRuntimeAdapterFailureMessage(
      "runtime adapter provision failed: HTTP 422",
      "release transport failed",
      "generic release text",
    ),
    "runtime adapter provision failed: HTTP 422",
  );
});

test("runtime adapter terminal failures stay retryable until lifecycle release", () => {
  assert.equal(runtimeAdapterTerminalFailureStatus("runtime-v1"), "detached");
  assert.equal(runtimeAdapterTerminalFailureStatus("legacy"), "expired");
  assert.equal(runtimeAdapterTerminalFailureStatus(null), "expired");
});

test("runtime adapter provider identities never become legacy lease ids", () => {
  assert.equal(legacyLeaseIdForAdapter("runtime-v1", "sandbox:provider-owned"), null);
  assert.equal(legacyLeaseIdForAdapter("runtime-v1", "cloudflare:provider-owned"), null);
  assert.equal(legacyLeaseIdForAdapter("legacy", "sandbox:legacy-owned"), "sandbox:legacy-owned");
});

test("confirmed stop races terminalize only after create ambiguity clears", () => {
  assert.deepEqual(resolveCreateAfterStopRace(true, "failed"), {
    status: "stopping",
    terminalStatus: "failed",
  });
  assert.deepEqual(resolveCreateAfterStopRace(false, "failed"), {
    status: "failed",
    terminalStatus: null,
  });
  assert.deepEqual(resolveCreateAfterStopRace(false, null), {
    status: "stopped",
    terminalStatus: null,
  });
});

test("runtime adapter lifecycle cannot escape durable session ownership", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const stopStart = source.indexOf("async function stopSupersededRuntimeAdapterProvision");
  const stopEnd = source.indexOf("async function resolveInteractiveSessionLineage", stopStart);
  const stopSource = source.slice(stopStart, stopEnd);
  const reconcileStart = source.indexOf("async function reconcileExternalInteractiveSession(");
  const reconcileEnd = source.indexOf("function reconciledInteractiveStatus", reconcileStart);
  const reconcileSource = source.slice(reconcileStart, reconcileEnd);
  const releaseStart = source.indexOf("async function releaseFailedRuntimeAdapterProvision");
  const releaseEnd = source.indexOf("function runtimeAdapterProvisionResult", releaseStart);
  const releaseSource = source.slice(releaseStart, releaseEnd);

  assert.match(
    source,
    /versioned runtime adapter requires a durable interactive session lifecycle/,
  );
  assert.match(stopSource, /recordConfirmedRuntimeAdapterRelease/);
  assert.match(stopSource, /select\(\[[\s\S]*"adapter_create_pending"[\s\S]*"terminal_status"/);
  assert.match(stopSource, /AND adapter_create_pending = \$\{lifecycle\.adapter_create_pending\}/);
  assert.match(stopSource, /terminal_status IS NULL/);
  assert.match(stopSource, /AND updated_at = \$\{lifecycle\.updated_at\}/);
  assert.match(stopSource, /MAX\(updated_at \+ 1, \$\{now\}\)/);
  assert.match(stopSource, /env\.DB\.batch/);
  assert.match(stopSource, /INSERT INTO interactive_session_events/);
  assert.match(stopSource, /finalizeTerminalInteractiveSession/);
  assert.match(stopSource, /terminal_finalize_pending: 1/);
  assert.ok(
    stopSource.indexOf("clearRuntimeAdapterCreatePending") <
      stopSource.indexOf("const release = await stopRuntimeAdapterWorkspaceForSession"),
  );
  assert.ok(
    releaseSource.indexOf("stageFailedRuntimeAdapterRelease") <
      releaseSource.indexOf("stopRuntimeAdapterWorkspace"),
  );
  assert.match(releaseSource, /status: "stopping"/);
  assert.match(releaseSource, /release\.message/);
  assert.match(releaseSource, /pendingMessage/);
  assert.match(releaseSource, /terminal_status: "failed"/);
  assert.match(releaseSource, /adapter_create_pending: 0/);
  assert.match(reconcileSource, /current\.stoppedAt \?\? now/);
  assert.match(reconcileSource, /finalizeTerminalInteractiveSession/);
  assert.match(source, /AND NOT EXISTS \(/);
  assert.match(source, /archiveInteractiveSessionLogs\(env, id, now, \{ force: true \}\)/);
});

test("confirmed adapter failure release keeps the original failure evidence", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const migration = await readFile(
    new URL("../migrations/0021_runtime_adapter_hardening.sql", import.meta.url),
    "utf8",
  );
  const releaseStart = source.indexOf("async function recordConfirmedRuntimeAdapterRelease");
  const releaseEnd = source.indexOf(
    "async function clearRuntimeAdapterCreatePending",
    releaseStart,
  );
  const releaseSource = source.slice(releaseStart, releaseEnd);
  const finalizeStart = source.indexOf("async function finalizeTerminalInteractiveSession");
  const finalizeEnd = source.indexOf("async function archiveInteractiveSessionLogs", finalizeStart);
  const finalizeSource = source.slice(finalizeStart, finalizeEnd);

  assert.match(releaseSource, /"terminal_failure_reason"/);
  assert.match(releaseSource, /retainedRuntimeAdapterFailureMessage/);
  assert.match(
    releaseSource,
    /terminal_failure_reason: resolved\.status === "failed" \? failureMessage/,
  );
  assert.match(releaseSource, /reconcile_error: resolved\.status === "failed" \? failureMessage/);
  assert.match(releaseSource, /\? failureMessage/);
  assert.match(finalizeSource, /retainedRuntimeAdapterFailureMessage/);
  assert.match(finalizeSource, /INSERT INTO interactive_session_events/);
  assert.match(finalizeSource, /SELECT \$\{id\}, 'system', \$\{message\}/);
  assert.match(migration, /ADD COLUMN terminal_failure_reason TEXT/);
});

test("terminal archive finalization remains durably retryable", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const migration = await readFile(
    new URL("../migrations/0021_runtime_adapter_hardening.sql", import.meta.url),
    "utf8",
  );
  const appendStart = source.indexOf("async function appendInteractiveSessionEvent");
  const appendEnd = source.indexOf(
    "async function finalizeTerminalInteractiveSession",
    appendStart,
  );
  const appendSource = source.slice(appendStart, appendEnd);
  const finalizeStart = source.indexOf("async function finalizeTerminalInteractiveSession");
  const finalizeEnd = source.indexOf("async function archiveInteractiveSessionLogs", finalizeStart);
  const finalizeSource = source.slice(finalizeStart, finalizeEnd);

  assert.match(source, /expression\("terminal_finalize_pending", "=", 1\)/);
  assert.match(source, /row\.terminal_finalize_pending === 1/);
  assert.match(source, /const terminalCleanupDeletePending = 2/);
  assert.match(source, /completeTerminalFinalization/);
  assert.match(source, /SET terminal_finalize_pending = 0/);
  assert.match(source, /interactive_session_log_archives\.events_key IS NULL/);
  assert.match(source, /interactive_session_log_archives\.transcript_key IS NULL/);
  assert.match(source, /interactive_session_log_archives\.summary_key IS NULL/);
  assert.match(source, /archive\.session_updated_at = interactive_sessions\.updated_at/);
  assert.match(
    source,
    /excluded\.session_updated_at > interactive_session_log_archives\.session_updated_at/,
  );
  assert.match(
    source,
    /excluded\.session_updated_at IS interactive_session_log_archives\.session_updated_at/,
  );
  assert.doesNotMatch(
    source,
    /session_updated_at IS NOT excluded\.session_updated_at[\s\S]*excluded\.updated_at >=/,
  );
  assert.match(appendSource, /executeBatch\(env, \[/);
  assert.match(appendSource, /insertInto\("interactive_session_events"\)/);
  assert.match(appendSource, /terminalFinalizationPendingQuery\(db, id\)/);
  assert.match(finalizeSource, /executeBatch\(env, \[/);
  assert.match(finalizeSource, /INSERT INTO interactive_session_events/);
  assert.match(finalizeSource, /terminalFinalizationPendingQuery\(db, id\)/);
  assert.match(migration, /ADD COLUMN terminal_finalize_pending INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /ADD COLUMN session_updated_at INTEGER/);
  assert.match(migration, /status IN \('stopped', 'expired', 'failed'\)/);
});

test("enabling R2 requeues D1-only terminal archives for object backfill", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const backfillStart = source.indexOf("async function requeueTerminalArchiveObjectBackfill");
  const batchStart = source.indexOf(
    "async function reconcileExternalInteractiveSessionBatch",
    backfillStart,
  );
  const targetedStart = source.indexOf(
    "async function reconcileExternalInteractiveSessionById",
    batchStart,
  );
  const reconcileStart = source.indexOf(
    "async function reconcileExternalInteractiveSession(",
    targetedStart,
  );
  const backfillSource = source.slice(backfillStart, batchStart);
  const batchSource = source.slice(batchStart, targetedStart);
  const targetedSource = source.slice(targetedStart, reconcileStart);

  assert.match(backfillSource, /if \(!env\.SESSION_LOGS\) return/);
  assert.match(backfillSource, /session\.terminal_finalize_pending = 0/);
  assert.match(backfillSource, /archive\.events_key IS NULL/);
  assert.match(backfillSource, /archive\.transcript_key IS NULL/);
  assert.match(backfillSource, /archive\.summary_key IS NULL/);
  assert.match(backfillSource, /SET terminal_finalize_pending = 1/);
  assert.match(backfillSource, /last_reconciled_at = NULL/);
  assert.match(batchSource, /await requeueTerminalArchiveObjectBackfill\(env\)/);
  assert.match(targetedSource, /await requeueTerminalArchiveObjectBackfill\(env, id\)/);
});

test("runtime reconciliation has scheduled and targeted lifecycle clocks", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const targetedStart = source.indexOf("async function reconcileExternalInteractiveSessionById");
  const targetedEnd = source.indexOf(
    "async function reconcileExternalInteractiveSession(",
    targetedStart,
  );
  const targetedSource = source.slice(targetedStart, targetedEnd);
  const batchStart = source.indexOf("async function reconcileExternalInteractiveSessionBatch");
  const batchEnd = source.indexOf("async function reconcileExternalInteractiveSessionById");
  const batchSource = source.slice(batchStart, batchEnd);
  const reconcileStart = source.indexOf("async function reconcileExternalInteractiveSession(");
  const reconcileEnd = source.indexOf("function reconciledInteractiveStatus", reconcileStart);
  const reconcileSource = source.slice(reconcileStart, reconcileEnd);

  assert.match(source, /async scheduled\(/);
  assert.match(source, /context\.waitUntil\(\s*reconcileInteractiveSessionLifecycleBatch/);
  assert.match(config, /"crons": \["\* \* \* \* \*"\]/);
  assert.match(batchSource, /expression\("terminal_finalize_pending", "=", 1\)/);
  assert.match(batchSource, /expression\("adapter", "=", runtimeAdapterName\)/);
  assert.match(targetedSource, /reconcileCredentialPolicyCleanupBatch\(env, now, id\)/);
  assert.match(targetedSource, /row\.terminal_finalize_pending === 1/);
  assert.match(targetedSource, /row\.adapter !== runtimeAdapterName/);
  assert.match(targetedSource, /runtimeAdapterReconcileIntervalMs/);
  assert.match(targetedSource, /reconcileExternalInteractiveSession\(env, row, now\)/);
  assert.ok(
    reconcileSource.indexOf("if (terminalFinalizationStatus)") <
      reconcileSource.indexOf("inspectRuntimeAdapterWorkspace"),
  );
  assert.match(source, /async function readFreshInteractiveSession/);
  assert.match(source, /async function interactiveSessionPty[\s\S]*readFreshInteractiveSession/);
  assert.match(source, /async function interactiveSessionVnc[\s\S]*readFreshInteractiveSession/);
  assert.match(source, /scheduled interactive session reconciliation failed/);
  assert.match(
    source,
    /async function reconcileInteractiveSessionLifecycleBatch[\s\S]*reconcileCredentialPolicyCleanupBatch[\s\S]*reconcileExternalInteractiveSessionBatch/,
  );
  assert.match(reconcileSource, /const claimAt = Math\.max/);
  assert.match(reconcileSource, /where\("updated_at", "=", row\.updated_at\)/);
  assert.match(reconcileSource, /const completedAt = Math\.max\(Date\.now\(\), claimAt\)/);
  assert.match(
    reconcileSource,
    /const completionVersion = Math\.max\(completedAt, row\.updated_at \+ 1\)/,
  );
  assert.match(reconcileSource, /last_reconciled_at: completedAt/);
  assert.match(reconcileSource, /updated_at: completionVersion/);
  assert.match(reconcileSource, /INSERT INTO interactive_session_events/);
  assert.match(reconcileSource, /env\.DB\.batch/);
  assert.match(reconcileSource, /reconcile_error: safeProviderError/);
  assert.doesNotMatch(reconcileSource, /updated_at: now/);
});

test("recurring terminal authorization never awaits provider reconciliation", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const grantStart = source.indexOf("function terminalInputGrant");
  const grantEnd = source.indexOf("function sendTerminalFrame", grantStart);
  const grantSource = source.slice(grantStart, grantEnd);
  const controlStart = source.indexOf("async function canControlInteractiveSessionById");
  const controlEnd = source.indexOf("function canGrantDelegatedControl", controlStart);
  const controlSource = source.slice(controlStart, controlEnd);
  const shareStart = source.indexOf("async function isSharedSessionToken");
  const shareEnd = source.indexOf("function sendTerminalFrame", shareStart);
  const shareSource = source.slice(shareStart, shareEnd);
  const bridgeStart = source.indexOf("function bridgeWebSockets");
  const bridgeEnd = source.indexOf("async function webSocketMessageData", bridgeStart);
  const bridgeSource = source.slice(bridgeStart, bridgeEnd);

  assert.match(grantSource, /cachedBooleanGrant/);
  assert.match(grantSource, /terminalSubscriptionReconciler/);
  assert.match(grantSource, /void reconcileExternalInteractiveSessionById/);
  assert.doesNotMatch(controlSource, /reconcileExternalInteractiveSessionById/);
  assert.doesNotMatch(controlSource, /reconcileCredentialPolicyCleanupBatch|runtimeAdapterFetch/);
  assert.doesNotMatch(shareSource, /reconcileExternalInteractiveSessionById/);
  assert.doesNotMatch(shareSource, /reconcileCredentialPolicyCleanupBatch|runtimeAdapterFetch/);
  assert.match(bridgeSource, /reconcileSubscription\?\.\(\)/);
  assert.doesNotMatch(bridgeSource, /await reconcileSubscription/);
});

test("public auth deployment metadata excludes runtime routing", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const publicStart = source.indexOf("function publicDeploymentConfig");
  const publicEnd = source.indexOf("class D1Dialect", publicStart);
  const publicSource = source.slice(publicStart, publicEnd);

  assert.match(source, /deployment: publicDeploymentConfig\(env\)/);
  assert.match(publicSource, /label, canonicalUrl, productUrl, sshHost/);
  assert.doesNotMatch(publicSource, /preferredRepo|defaultRuntime|defaultProfile|RUNTIME_ADAPTER/);
});

test("strict session rows and cleanup preserve terminal finalization anchors", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const cleanupStart = source.indexOf("async function cleanupInteractiveSessions");
  const cleanupEnd = source.indexOf("async function mutateInteractiveSession", cleanupStart);
  const cleanupSource = source.slice(cleanupStart, cleanupEnd);

  assert.match(source, /type InteractiveSessionRow = Selectable<InteractiveSessionTable>/);
  assert.match(cleanupSource, /where\("terminal_finalize_pending", "=", 0\)/);
  assert.match(cleanupSource, /deleteFinalizedInteractiveSession\(env, row, archive\)/);
  assert.match(cleanupSource, /terminalCleanupDeletePending/);
  assert.match(cleanupSource, /updated_at", "=", row\.updated_at/);
  assert.match(cleanupSource, /executeBatch\(env, \[/);
  const archiveIndex = cleanupSource.indexOf('.selectFrom("interactive_session_log_archives")');
  const deleteIndex = cleanupSource.indexOf("deleteFinalizedInteractiveSession(env, row, archive)");
  const objectCleanupIndex = cleanupSource.indexOf("cleanupSessionLogArchiveObjects(env, archive)");
  assert.ok(archiveIndex >= 0 && deleteIndex > archiveIndex && objectCleanupIndex > deleteIndex);
  assert.match(cleanupSource, /session archive object cleanup leaked/);
  assert.match(cleanupSource, /events_key IS \$\{archive\?\.events_key/);
  assert.match(cleanupSource, /transcript_key IS \$\{archive\?\.transcript_key/);
  assert.match(cleanupSource, /summary_key IS \$\{archive\?\.summary_key/);
  assert.match(cleanupSource, /deleteFrom\("interactive_session_events"\)/);
  assert.match(cleanupSource, /deleteFrom\("interactive_session_log_archives"\)/);
  assert.match(cleanupSource, /deleteFrom\("interactive_sessions"\)/);
  assert.match(cleanupSource, /FROM interactive_session_credential_policies/);
  assert.equal(
    cleanupSource.match(/FROM interactive_sessions AS descendant/g)?.length,
    2,
  );
  assert.match(cleanupSource, /descendant\.root_session_id = interactive_sessions\.id/);
  assert.match(cleanupSource, /descendant\.root_session_id = \$\{row\.id\}/);
  assert.equal(
    cleanupSource.match(/descendant\.status NOT IN \('stopped', 'expired', 'failed'\)/g)?.length,
    2,
  );
  assert.match(source, /terminalFinalizationPendingQuery/);
  assert.match(source, /executeBatch\(env, \[[\s\S]*interactive_session_events/);
  assert.match(source, /COALESCE\([\s\S]*event_count[\s\S]*count\(\*\)/);
  assert.match(source, /events_key IS NOT NULL/);
});

test("summary and sharing events invalidate terminal cleanup snapshots", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const cleanupStart = source.indexOf("async function deleteFinalizedInteractiveSession");
  const cleanupEnd = source.indexOf("async function mutateInteractiveSession", cleanupStart);
  const cleanupSource = source.slice(cleanupStart, cleanupEnd);
  const shareStart = source.indexOf('if (action === "share_link")');
  const shareEnd = source.indexOf('if (action === "enable_multiplayer")', shareStart);
  const shareSource = source.slice(shareStart, shareEnd);
  const summaryStart = source.indexOf("async function updateInteractiveSessionSummary");
  const summaryEnd = source.indexOf("async function readInteractiveSessionLogs", summaryStart);
  const summarySource = source.slice(summaryStart, summaryEnd);
  const metadataStart = source.indexOf("async function mutateInteractiveSessionMetadataAtomically");
  const metadataEnd = source.indexOf("async function mutateInteractiveSession(", metadataStart);
  const metadataSource = source.slice(metadataStart, metadataEnd);

  assert.match(cleanupSource, /where\("updated_at", "=", row\.updated_at\)/);
  assert.match(cleanupSource, /terminal_finalize_pending: terminalCleanupDeletePending/);
  assert.match(cleanupSource, /event_count = \$\{archive\?\.event_count/);
  assert.match(cleanupSource, /archived_at = \$\{archive\?\.archived_at/);
  assert.match(cleanupSource, /count\(\*\)/);
  assert.match(shareSource, /mutateInteractiveSessionMetadataAtomically/);
  assert.match(summarySource, /mutateInteractiveSessionMetadataAtomically/);
  assert.match(metadataSource, /INSERT INTO interactive_session_events/);
  assert.match(metadataSource, /terminal_finalize_pending: sql<number>`CASE/);
  assert.match(metadataSource, /WHEN status IN \('stopped', 'expired', 'failed'\) THEN 1/);
  assert.match(metadataSource, /updated_at = \$\{session\.updatedAt\}/);
  assert.match(metadataSource, /\.returning\("updated_at"\)/);
  assert.match(metadataSource, /env\.DB\.batch/);
  assert.ok(metadataSource.indexOf("eventQuery") < metadataSource.indexOf("updateQuery"));
});

test("development identity login requires an explicit local gate", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const loginSource = source.slice(
    source.indexOf("async function devIdentityLogin"),
    source.indexOf("async function githubLogin"),
  );
  const requireSource = source.slice(
    source.indexOf("async function requireUser"),
    source.indexOf("async function optionalUser"),
  );
  const authStart = source.indexOf("function authMethods");
  const authSource = source.slice(authStart, source.indexOf("function actor", authStart));

  assert.match(source, /function devIdentityEnabled\(env: RuntimeEnv, request: Request\)/);
  assert.match(loginSource, /devIdentityEnabled\(env, request\)/);
  assert.match(requireSource, /devIdentityEnabled\(env, request\)/);
  assert.match(requireSource, /deleteFrom\("sessions"\)/);
  assert.match(authSource, /devIdentityEnabled\(env, request\)/);
  assert.match(
    authSource,
    /developmentIdentityEnabled\(env\.CRABFLEET_DEV_LOGIN_ENABLED, request\.url\)/,
  );
  assert.match(config, /"CRABFLEET_DEV_LOGIN_ENABLED": "false"/);
});

test("runtime adapter credentials are preflighted before session allocation", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const createStart = source.indexOf("async function createInteractiveSessionFromInput");
  const createEnd = source.indexOf("function initialRuntimeAdapterWorkspaceId", createStart);
  const createSource = source.slice(createStart, createEnd);
  const preflightStart = source.indexOf("function requireRuntimeAdapterCreatePreflight");
  const preflightEnd = source.indexOf(
    "async function stopSupersededRuntimeAdapterProvision",
    preflightStart,
  );
  const preflightSource = source.slice(preflightStart, preflightEnd);

  assert.ok(
    createSource.indexOf("requireRuntimeAdapterCreatePreflight(env, runtime, profile)") <
      createSource.indexOf("nextInteractiveSessionId(env)"),
  );
  assert.ok(
    createSource.indexOf("requireRuntimeAdapterCreatePreflight(env, runtime, profile)") <
      createSource.indexOf('.insertInto("interactive_sessions")'),
  );
  assert.match(preflightSource, /runtime === "container" && env\.SANDBOX/);
  assert.match(preflightSource, /runtimeAdapterToken\(env\)/);
  assert.match(preflightSource, /configuredRuntimeAdapterControlPlane\(env, profile\)/);
  assert.match(preflightSource, /runtimeAdapterControlPlaneForProfile/);
  assert.match(preflightSource, /runtime adapter token is not configured/);
});

test("runtime adapter operations stay bound to the registered control plane", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const migration = await readFile(
    new URL("../migrations/0020_runtime_adapter_lifecycle.sql", import.meta.url),
    "utf8",
  );
  const bindingStart = source.indexOf("function configuredRuntimeAdapterControlPlane");
  const bindingEnd = source.indexOf(
    "async function stopSupersededRuntimeAdapterProvision",
    bindingStart,
  );
  const bindingSource = source.slice(bindingStart, bindingEnd);
  const provisionStart = source.indexOf("async function provisionWithRuntimeAdapter");
  const provisionEnd = source.indexOf("function persistedRuntimeAdapterSeconds", provisionStart);
  const provisionSource = source.slice(provisionStart, provisionEnd);
  const inspectStart = source.indexOf("async function inspectRuntimeAdapterWorkspace");
  const inspectEnd = source.indexOf(
    "async function reconcileStoppingRuntimeAdapterWorkspace",
    inspectStart,
  );
  const inspectSource = source.slice(inspectStart, inspectEnd);
  const stopStart = source.indexOf("async function stopRuntimeAdapterWorkspace(");
  const stopEnd = source.indexOf("async function runtimeAdapterFetch", stopStart);
  const stopSource = source.slice(stopStart, stopEnd);

  assert.match(migration, /ADD COLUMN adapter_control_plane TEXT/);
  assert.match(source, /adapter_control_plane: adapterControlPlane/);
  assert.match(bindingSource, /configuredControlPlane !== registeredControlPlane/);
  assert.match(bindingSource, /configuredRuntimeAdapterControlPlane\(env, profile\)/);
  assert.match(bindingSource, /control plane differs from workspace registration/);
  assert.match(provisionSource, /requireRegisteredRuntimeAdapterControlPlane/);
  assert.match(provisionSource, /runtimeAdapterCollectionUrl\(baseUrl\)/);
  assert.match(inspectSource, /session\.adapter_control_plane/);
  assert.match(inspectSource, /runtimeAdapterWorkspaceUrl\(controlPlane, adapterWorkspaceId\)/);
  assert.match(stopSource, /requireRegisteredRuntimeAdapterControlPlane/);
  assert.match(stopSource, /runtimeAdapterWorkspaceUrl\(controlPlane, adapterWorkspaceId\)/);
  assert.doesNotMatch(
    inspectSource,
    /runtimeAdapterWorkspaceUrl\(env\.CRABBOX_RUNTIME_ADAPTER_URL/,
  );
  assert.doesNotMatch(stopSource, /response\.status === 404[\s\S]*CRABBOX_RUNTIME_ADAPTER_URL/);
});

test("runtime adapter requests reject redirects with edge-supported fetch semantics", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const fetchStart = source.indexOf("async function runtimeAdapterFetch");
  const fetchEnd = source.indexOf("async function readRuntimeAdapterResponseBody", fetchStart);
  const fetchSource = source.slice(fetchStart, fetchEnd);

  assert.match(fetchSource, /redirect: "manual"/);
  assert.match(fetchSource, /response\.status >= 300 && response\.status < 400/);
  assert.match(fetchSource, /runtime adapter redirect refused/);
  assert.doesNotMatch(fetchSource, /redirect: "error"/);
});

test("pending runtime adapter creates replay before any inspect", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const inspectStart = source.indexOf("async function inspectRuntimeAdapterWorkspace");
  const inspectEnd = source.indexOf(
    "async function reconcileStoppingRuntimeAdapterWorkspace",
    inspectStart,
  );
  const inspectSource = source.slice(inspectStart, inspectEnd);
  const provisionStart = source.indexOf("async function provisionWithRuntimeAdapter");
  const provisionEnd = source.indexOf("function persistedRuntimeAdapterSeconds", provisionStart);
  const provisionSource = source.slice(provisionStart, provisionEnd);
  const replayIndex = inspectSource.indexOf(
    "shouldReplayRuntimeAdapterCreate(session.status, session.adapter_create_pending === 1)",
  );
  const inspectFetchIndex = inspectSource.indexOf("const response = await runtimeAdapterFetch(");
  const missingIndex = inspectSource.indexOf("if (response.status === 404)");
  const missingSource = inspectSource.slice(missingIndex);

  assert.ok(replayIndex >= 0);
  assert.ok(inspectFetchIndex >= 0);
  assert.ok(replayIndex < inspectFetchIndex);
  assert.match(inspectSource, /runtimeAdapterReplayRequest\(runtimeAdapterRecord\(session\)\)/);
  assert.ok(missingIndex >= 0);
  assert.doesNotMatch(missingSource, /provisionWithRuntimeAdapter/);
  assert.match(provisionSource, /const replayingPendingCreate = reconciliationOwner !== undefined/);
  assert.match(
    provisionSource,
    /!replayingPendingCreate && definitiveRuntimeAdapterCreateFailure\(response\.status\)/,
  );
  assert.match(provisionSource, /runtime adapter create replay blocked/);
});

test("stopping create replay owns the exact persisted lifecycle", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const reconcileStart = source.indexOf("async function reconcileStoppingRuntimeAdapterWorkspace");
  const replayStart = source.indexOf("async function replayStoppingRuntimeAdapterCreate");
  const replayEnd = source.indexOf("async function stopRuntimeAdapterWorkspace(", replayStart);
  const reconcileSource = source.slice(reconcileStart, replayStart);
  const replaySource = source.slice(replayStart, replayEnd);
  const unresolvedIndex = reconcileSource.indexOf("if (!replay.resolved)");
  const deleteIndex = reconcileSource.indexOf("stopRuntimeAdapterWorkspace(");

  assert.match(reconcileSource, /replayStoppingRuntimeAdapterCreate\([\s\S]*env,[\s\S]*session,/);
  assert.doesNotMatch(reconcileSource, /provisionWithRuntimeAdapter/);
  assert.ok(unresolvedIndex >= 0);
  assert.ok(deleteIndex >= 0);
  assert.ok(unresolvedIndex < deleteIndex);
  assert.match(reconcileSource, /reconcileError: replay\.message/);
  assert.match(reconcileSource, /createPending: true/);
  assert.match(replaySource, /AND adapter_control_plane = \$\{controlPlane\}/);
  assert.match(replaySource, /AND adapter_create_payload_json = \$\{createPayloadJson\}/);
  assert.match(replaySource, /AND adapter_create_pending = 1/);
  assert.match(replaySource, /AND status = 'stopping'/);
  assert.match(replaySource, /AND updated_at = \$\{session\.updated_at\}/);
  assert.match(replaySource, /AND last_reconciled_at = \$\{reconciliationClaimAt\}/);
  assert.match(replaySource, /runtimeAdapterCollectionUrl\(controlPlane\)/);
  assert.match(replaySource, /idempotency-key": adapterWorkspaceId/);
  assert.match(replaySource, /adapter_create_pending: 0/);
  assert.match(replaySource, /reconcile_error: message/);
  assert.match(replaySource, /INSERT INTO interactive_session_events/);
  assert.match(replaySource, /env\.DB\.batch/);
});

test("every session-bound adapter delete waits for create ambiguity to clear", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const releaseStart = source.indexOf("async function stopRuntimeAdapterWorkspaceForSession");
  const releaseEnd = source.indexOf("async function runtimeAdapterFetch", releaseStart);
  const releaseSource = source.slice(releaseStart, releaseEnd);
  const pendingGateIndex = releaseSource.indexOf("if (registration?.adapter_create_pending !== 0)");
  const providerDeleteIndex = releaseSource.indexOf("return stopRuntimeAdapterWorkspace(");

  assert.match(
    releaseSource,
    /select\(\["adapter_control_plane", "adapter_create_pending", "profile"\]\)/,
  );
  assert.ok(pendingGateIndex >= 0);
  assert.ok(providerDeleteIndex >= 0);
  assert.ok(pendingGateIndex < providerDeleteIndex);
  assert.match(releaseSource, /status: "stopping"/);
  assert.match(releaseSource, /runtime adapter stop waiting for create resolution/);
});

test("stateless Sandbox provision hook acquires durable standalone ownership", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const migration = await readFile(
    new URL("../migrations/0022_credential_policy_cleanup.sql", import.meta.url),
    "utf8",
  );
  const expiryMigration = await readFile(
    new URL("../migrations/0023_standalone_sandbox_expiry.sql", import.meta.url),
    "utf8",
  );
  const endpointStart = source.indexOf("async function provisionInteractiveEndpoint");
  const endpointEnd = source.indexOf("function isBuiltInInteractiveProvisionUrl", endpointStart);
  const endpointSource = source.slice(endpointStart, endpointEnd);
  const ownershipStart = source.indexOf("function sandboxCredentialPolicyOwnerCondition");
  const ownershipEnd = source.indexOf(
    "function sandboxCredentialPolicyRegistrationQueries",
    ownershipStart,
  );
  const ownershipSource = source.slice(ownershipStart, ownershipEnd);
  const managedStart = source.indexOf("async function provisionManagedSandboxEndpoint");
  const managedEnd = source.indexOf("async function provisionStandaloneSandbox", managedStart);
  const managedSource = source.slice(managedStart, managedEnd);
  const managedCommitSource = managedSource.slice(managedSource.indexOf("const commitRevision"));
  const ptyStart = source.indexOf("async function standaloneSandboxPty");
  const ptyEnd = source.indexOf("function isBuiltInInteractiveProvisionUrl", ptyStart);
  const ptySource = source.slice(ptyStart, ptyEnd);
  const sandboxStart = source.indexOf("async function provisionWithSandbox");
  const sandboxEnd = source.indexOf("function sandboxManagedOwnershipCondition", sandboxStart);
  const sandboxSource = source.slice(sandboxStart, sandboxEnd);
  const activationSource = endpointSource.slice(endpointSource.indexOf("const activationVersion"));
  const stopStart = source.indexOf("async function stopStandaloneSandboxProvision");
  const stopEnd = source.indexOf("function standaloneSandboxAttachUrl", stopStart);
  const stopSource = source.slice(stopStart, stopEnd);
  const expiryStart = source.indexOf("async function expireStandaloneSandboxProvisions");
  const expirySource = source.slice(expiryStart, stopStart);
  const standaloneCleanupStart = source.indexOf(
    "async function completeStandaloneSandboxProvisionCleanup",
  );
  const standaloneCleanupEnd = source.indexOf(
    "async function completeCredentialPolicyCleanupSession",
    standaloneCleanupStart,
  );
  const standaloneCleanupSource = source.slice(standaloneCleanupStart, standaloneCleanupEnd);
  const strictAuthStart = source.indexOf("function authorizeProvisionBearerToken");
  const strictAuthEnd = source.indexOf("function sandboxProvisionPreflightError", strictAuthStart);
  const strictAuthSource = source.slice(strictAuthStart, strictAuthEnd);

  assert.match(endpointSource, /selectFrom\("interactive_sessions"\)/);
  assert.match(endpointSource, /if \(managed\)/);
  assert.ok(
    endpointSource.indexOf("if (managed)") <
      endpointSource.indexOf("return provisionStandaloneSandbox(env, payload)"),
  );
  assert.match(endpointSource, /provisionManagedSandboxEndpoint\(env, payload, managed\)/);
  assert.match(endpointSource, /managedInteractiveSessionId\(payload\.id\)/);
  assert.match(endpointSource, /managed session namespace/);
  assert.match(endpointSource, /INSERT INTO standalone_sandbox_provisions/);
  assert.match(endpointSource, /ownership_claim_expires_at/);
  assert.match(endpointSource, /\$\{sandboxLeaseId\(lease\)\}/);
  assert.match(endpointSource, /lease_id = excluded\.lease_id/);
  assert.match(endpointSource, /provisionWithSandbox\([\s\S]*fence/);
  assert.match(endpointSource, /state: "active"/);
  assert.match(ownershipSource, /FROM standalone_sandbox_provisions AS owner/);
  assert.match(ownershipSource, /owner\.ownership_claim = \$\{ownershipFence\.claim\}/);
  assert.match(managedSource, /managedSandboxProvisionPayloadMatches/);
  assert.ok(
    managedSource.indexOf("managedSandboxProvisionPayloadMatches") <
      managedSource.indexOf("newSandboxLease(payload.id)"),
  );
  assert.match(managedSource, /where\("updated_at", "=", session\.updated_at\)/);
  assert.match(managedSource, /sandbox_refresh_claim: fence\.claim/);
  assert.match(managedSource, /const agentToken = newAgentToken\(\)/);
  assert.match(managedSource, /const agentTokenHash = await sha256\(agentToken\)/);
  assert.match(managedSource, /agent_token_hash: agentTokenHash/);
  assert.match(managedSource, /agent_token_hash IS \$\{session\.agent_token_hash\}/);
  assert.match(managedSource, /provisionWithSandbox\(env, payload, agentToken, lease, fence\)/);
  assert.ok(
    managedSource.indexOf("sandboxProvisionPreflightError(env, payload)") <
      managedSource.indexOf("const agentToken = newAgentToken()"),
  );
  assert.match(managedSource, /stageFailedManagedSandboxProvision/);
  assert.match(managedSource, /where\("agent_token_hash", "=", agentTokenHash\)/);
  assert.doesNotMatch(managedSource, /provisionWithSandbox\(env, payload, undefined/);
  assert.match(managedSource, /executeBatch\(env, commitQueries\)/);
  assert.match(managedCommitSource, /MAX\(updated_at \+ 1, \$\{commitRevision\}\)/);
  assert.doesNotMatch(managedCommitSource, /where\("updated_at", "=", now\)/);
  assert.match(managedCommitSource, /lease_id IS \$\{fence\.refreshLeaseId\}/);
  assert.match(managedCommitSource, /sandbox_refresh_claim", "=", fence\.claim/);
  assert.match(managedCommitSource, /sandbox_refresh_claim_expires_at", "=", fence\.expiresAt/);
  assert.match(managedSource, /previousSandboxId/);
  assert.match(managedSource, /state: "cleanup_pending"/);
  assert.match(managedSource, /claimed\.numUpdatedRows/);
  assert.match(ptySource, /authorizeProvisionEndpoint\(request, env\)/);
  assert.match(ptySource, /standalone_sandbox_provisions/);
  assert.match(ptySource, /where\("state", "=", "active"\)/);
  assert.match(ptySource, /owner\.expires_at <= Date\.now\(\)/);
  assert.match(ptySource, /stageStandaloneSandboxProvisionCleanup/);
  assert.match(ptySource, /activeSandboxCredentialPolicyGeneration/);
  assert.match(ptySource, /terminalHeaders\.delete\("authorization"\)/);
  assert.match(ptySource, /const pair = new WebSocketPair\(\)/);
  assert.match(ptySource, /response\.webSocket\.accept\(\)/);
  assert.match(ptySource, /bridgeWebSockets\(/);
  assert.match(ptySource, /standaloneSandboxTerminalGrant/);
  assert.match(ptySource, /cachedBooleanGrant/);
  assert.match(ptySource, /where\("request_hash", "=", ownership\.requestHash\)/);
  assert.match(ptySource, /where\("expires_at", ">", now\)/);
  assert.match(ptySource, /where\("updated_at", "=", ownership\.updatedAt\)/);
  assert.match(ptySource, /activeSandboxCredentialPolicyCondition/);
  assert.match(ptySource, /return new Response\(null, \{ status: 101, webSocket: client \}\)/);
  assert.doesNotMatch(ptySource, /return response;/);
  assert.match(standaloneCleanupSource, /deleteSession\(lease\.terminalSessionId\)/);
  assert.match(standaloneCleanupSource, /isSandboxSessionAlreadyGone/);
  assert.ok(
    standaloneCleanupSource.indexOf("deleteSession(lease.terminalSessionId)") <
      standaloneCleanupSource.indexOf('.deleteFrom("standalone_sandbox_provisions")'),
  );
  assert.match(standaloneCleanupSource, /where\("updated_at", "=", owner\.updated_at\)/);
  assert.match(sandboxSource, /standaloneSandboxAttachUrl\(env, session\.id\)/);
  assert.match(
    endpointSource,
    /const activationVersion = Math\.max\(Date\.now\(\), finishedAt \+ 1\)/,
  );
  assert.match(activationSource, /executeBatch\(env, \[/);
  assert.ok(
    activationSource.indexOf('.updateTable("interactive_session_credential_policies")') <
      activationSource.indexOf('.updateTable("standalone_sandbox_provisions")'),
  );
  assert.match(activationSource, /set\(\{ updated_at: activationVersion \}\)/);
  assert.match(
    endpointSource,
    /activeSandboxCredentialPolicyCondition\([\s\S]*policyGeneration,[\s\S]*activationVersion/,
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS standalone_sandbox_provisions/);
  assert.match(migration, /request_hash TEXT NOT NULL/);
  assert.match(migration, /sandbox_id TEXT NOT NULL UNIQUE/);
  assert.match(expiryMigration, /ADD COLUMN expires_at INTEGER/);
  assert.match(expiryMigration, /substr\(lower\(id\), 4\) NOT GLOB '\*\[\^0-9\]\*'/);
  assert.match(expiryMigration, /idx_standalone_sandbox_provision_expiry/);
  assert.match(expirySource, /state = 'active'/);
  assert.match(expirySource, /expires_at <= \$\{now\}/);
  assert.match(expirySource, /substr\(lower\(id\), 4\) NOT GLOB '\*\[\^0-9\]\*'/);
  assert.match(stopSource, /authorizeProvisionBearerToken\(request, env\)/);
  assert.match(strictAuthSource, /if \(!env\.CRABBOX_INTERACTIVE_PROVISION_TOKEN\)/);
  assert.match(strictAuthSource, /throw serviceUnavailable/);
  assert.doesNotMatch(strictAuthSource, /hasBackend/);
  assert.match(stopSource, /stageStandaloneSandboxProvisionCleanup/);
  assert.match(stopSource, /reconcileCredentialPolicyCleanupBatch/);
  assert.match(stopSource, /status: remaining \? "stopping" : "stopped"/);
  assert.match(source, /CRABBOX_STANDALONE_SANDBOX_TTL_SECONDS/);
  assert.match(source, /function managedInteractiveSessionId/);
  assert.match(source, /standaloneProvisionStopMatch/);
  assert.match(source, /stopStandaloneSandboxProvision/);
  assert.match(source, /policy\?\.expiresAt !== undefined && policy\.expiresAt <= Date\.now\(\)/);
  assert.match(source, /standaloneSandboxPolicyExpiresAt/);
  assert.match(
    source,
    /selectFrom\("standalone_sandbox_provisions"\)[\s\S]*failed to allocate an unreserved interactive session id/,
  );
  assert.match(source, /id = \$\{id\} COLLATE NOCASE/);
  assert.match(expiryMigration, /UPDATE id_sequences/);
  assert.match(expiryMigration, /MAX\(CAST\(substr\(lower\(id\), 4\) AS INTEGER\)\)/);
});

test("Sandbox credential egress proves the durable generation and owner", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const readStart = source.indexOf("async function sandboxCredentialPolicy(");
  const readEnd = source.indexOf("async function sandboxOutbound", readStart);
  const readSource = source.slice(readStart, readEnd);
  const controlStart = source.indexOf("export class SessionControlDO");
  const controlEnd = source.indexOf(
    "function validSandboxCredentialPolicyRegistration",
    controlStart,
  );
  const controlSource = source.slice(controlStart, controlEnd);
  const egressStart = controlSource.indexOf("const egressMatch");
  const egressEnd = controlSource.indexOf("const sandboxMatch", egressStart);
  const egressSource = controlSource.slice(egressStart, egressEnd);

  assert.match(readSource, /x-crabfleet-policy-generation/);
  assert.match(readSource, /response\.status === 409/);
  assert.match(readSource, /repairLegacySandboxCredentialPolicyBatch/);
  assert.match(readSource, /response = await stub\.fetch\(policyUrl\)/);
  assert.match(readSource, /sandboxCredentialPolicyHasDurableOwner/);
  assert.match(readSource, /interactive_session_credential_policies/);
  assert.match(readSource, /activeSandboxCredentialPolicyGeneration/);
  assert.match(readSource, /sandboxCredentialPolicyCleanupAuthorizedCondition/);
  assert.match(readSource, /policy\.expiresAt === standalone\.expires_at/);
  assert.match(controlSource, /const current = storedSandboxCredentialPolicy\(stored\)/);
  assert.match(controlSource, /if \(!current \|\| !policy\)/);
  assert.doesNotMatch(egressSource, /storage\.delete/);
  assert.match(egressSource, /legacy credential policy migration required/);
  assert.match(egressSource, /status: 409/);
  assert.match(controlSource, /return current\.policy/);
  assert.doesNotMatch(
    controlSource,
    /storedSandboxCredentialPolicy\(value\)\?\.policy \?\? legacySandboxCredentialPolicy/,
  );
});

test("cron generation-wraps migrated legacy policies under exact live ownership", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const batchStart = source.indexOf("async function reconcileCredentialPolicyCleanupBatch");
  const batchEnd = source.indexOf("async function reconcileCredentialPolicyCleanup(", batchStart);
  const batchSource = source.slice(batchStart, batchEnd);
  const beginStart = source.indexOf("async function beginLegacySandboxCredentialPolicyRepair");
  const renewStart = source.indexOf(
    "async function renewSandboxCredentialPolicyRegistration",
    beginStart,
  );
  const repairSource = source.slice(beginStart, renewStart);
  const controlStart = source.indexOf("export class SessionControlDO");
  const controlEnd = source.indexOf("function storedSandboxCredentialPolicy", controlStart);
  const controlSource = source.slice(controlStart, controlEnd);

  assert.ok(
    batchSource.indexOf("repairLegacySandboxCredentialPolicyBatch") <
      batchSource.indexOf("scanCredentialPolicyCleanupPage"),
  );
  assert.match(repairSource, /credentialPolicyLegacyGenerationPrefix/);
  assert.match(repairSource, /credentialPolicyLegacyRepairClaimPrefix/);
  assert.match(repairSource, /sandboxCredentialPolicyRegistrationQueries/);
  assert.match(repairSource, /const ownership: SandboxCurrentLeaseFence/);
  assert.match(repairSource, /renewSandboxCredentialPolicyRegistration/);
  assert.match(repairSource, /\/api\/session-control\/migrate-legacy/);
  assert.match(repairSource, /sandboxIds: registration\.lookupIds/);
  assert.match(repairSource, /finishSandboxCredentialPolicyRegistration/);
  assert.match(repairSource, /registration_claim_expires_at", "<=", now/);
  assert.match(controlSource, /migratedCredentialPolicyRecord/);
  assert.match(controlSource, /const sourcePolicy = records/);
  assert.match(controlSource, /migratedRecords/);
  assert.match(controlSource, /credentialPolicyMigrationCleanupMatches/);
  assert.match(controlSource, /this\.ctx\.storage\.transaction/);
});

test("active credential-policy generations recover after a post-DO crash", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const scanStart = source.indexOf("async function scanCredentialPolicyCleanupPage");
  const scanEnd = source.indexOf("async function readCredentialPolicyScanPage", scanStart);
  const scanSource = source.slice(scanStart, scanEnd);
  const repairStart = source.indexOf(
    "async function repairActiveSandboxCredentialPolicyRegistration",
  );
  const repairEnd = source.indexOf("function credentialPolicyScanRequiresCleanup", repairStart);
  const repairSource = source.slice(repairStart, repairEnd);
  const promoteStart = source.indexOf("async function promoteSandboxCredentialPolicyRegistration");
  const promoteEnd = source.indexOf("async function sandboxCredentialPolicyExists", promoteStart);
  const promoteSource = source.slice(promoteStart, promoteEnd);

  assert.ok(
    scanSource.indexOf("repairActiveSandboxCredentialPolicyRegistration") <
      scanSource.indexOf("credentialPolicyScanRequiresCleanup"),
  );
  assert.match(scanSource, /repairedRegistrations/);
  assert.match(scanSource, /deferredRegistrations/);
  assert.match(repairSource, /row\.policy_state !== "registering"/);
  assert.match(repairSource, /row\.registration_claim_expires_at/);
  assert.match(repairSource, /credentialPolicyScanOwnershipFence/);
  assert.match(repairSource, /sandboxCredentialPolicyExists/);
  assert.match(repairSource, /recordSandboxCredentialPolicyRefs\([\s\S]*"active"/);
  assert.match(repairSource, /repair lost durable ownership/);
  assert.match(promoteSource, /state: "active"/);
  assert.match(promoteSource, /registration_claim: null/);
  assert.match(promoteSource, /registration_claim_expires_at: null/);
  assert.match(promoteSource, /where\("registration_generation", "=", generation\)/);
  assert.match(promoteSource, /expression\("registration_claim_expires_at", "<=", now\)/);
  assert.match(promoteSource, /sandboxCredentialPolicyOwnerCondition/);
});

test("Sandbox credential registration always proves exact durable ownership", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const ownerStart = source.indexOf("function sandboxManagedOwnershipCondition");
  const ownerEnd = source.indexOf("async function abandonSandboxCredentialPolicyRegistration");
  const ownerSource = source.slice(ownerStart, ownerEnd);
  const createStart = source.indexOf("async function createInteractiveSessionFromInput");
  const createEnd = source.indexOf("function initialRuntimeAdapterWorkspaceId", createStart);
  const createSource = source.slice(createStart, createEnd);
  const ensureStart = source.indexOf("async function ensureSandboxCredentialPolicy");
  const ensureEnd = source.indexOf("async function recordSandboxCredentialPolicyRefs", ensureStart);
  const ensureSource = source.slice(ensureStart, ensureEnd);

  assert.doesNotMatch(ownerSource, /ownershipFence\?:/);
  assert.doesNotMatch(
    ownerSource,
    /ownershipFence: SandboxCredentialPolicyOwnershipFence \| undefined/,
  );
  assert.doesNotMatch(ownerSource, /1 = 1/);
  assert.match(ownerSource, /lease_id = \$\{ownershipFence\.leaseId\}/);
  assert.match(ownerSource, /sandbox_refresh_claim = \$\{ownershipFence\.claim\}/);
  assert.match(ownerSource, /AND \$\{sandboxId\} = \$\{ownershipFence\.sandboxId\}/);
  assert.match(createSource, /const initialSandboxLease/);
  assert.match(createSource, /const initialAgentTokenHash = await sha256\(agentToken\)/);
  assert.match(createSource, /lease_id: initialSandboxOwnership\?\.leaseId/);
  assert.match(createSource, /ownership: initialSandboxOwnership/);
  assert.match(ensureSource, /sandboxCurrentLeaseFence|SandboxCurrentLeaseFence/);
  assert.match(ensureSource, /credentialPolicyLegacyGenerationPrefix/);
  assert.match(ensureSource, /repairLegacySandboxCredentialPolicy/);
  assert.match(
    ensureSource,
    /registerSandboxCredentialPolicy\(env, session, sandboxId, ownership\)/,
  );
});

test("initial terminal adapter responses enter durable finalization", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const createStart = source.indexOf("async function createInteractiveSessionFromInput");
  const createEnd = source.indexOf("function initialRuntimeAdapterWorkspaceId", createStart);
  const createSource = source.slice(createStart, createEnd);
  const completionStart = createSource.indexOf("const provisionUpdate");
  const completionEnd = createSource.indexOf(
    "if ((provisionUpdate.numUpdatedRows",
    completionStart,
  );
  const completionSource = createSource.slice(completionStart, completionEnd);

  assert.ok(createStart >= 0 && createEnd > createStart);
  assert.match(createSource, /const initialTerminalStatus: "stopped" \| "expired" \| "failed"/);
  assert.match(createSource, /terminal_finalize_pending: initialTerminalStatus \? 1 : 0/);
  assert.match(createSource, /stopped_at: terminalAt/);
  assert.match(createSource, /agent_token_hash: null/);
  assert.match(createSource, /attach_url: initialTerminalStatus \? null/);
  assert.match(createSource, /adapter_create_pending: initialTerminalStatus/);
  assert.match(completionSource, /MAX\(updated_at \+ 1, \$\{completionVersionFloor\}\)/);
  assert.doesNotMatch(completionSource, /where\("updated_at"/);
  assert.match(createSource, /lease_id IS \$\{initialSandboxOwnership\?\.leaseId \?\? null\}/);
  assert.match(createSource, /where\("agent_token_hash", "=", initialAgentTokenHash\)/);
  assert.match(createSource, /where\("sandbox_refresh_sandbox_id", "is", null\)/);
  assert.match(createSource, /where\("sandbox_refresh_claim", "is", null\)/);
  assert.match(createSource, /where\("sandbox_refresh_claim_expires_at", "is", null\)/);
  assert.match(createSource, /finalizeTerminalInteractiveSession/);
});

test("create-only adapters reject stopping responses before persistence", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const externalStart = source.indexOf("async function provisionInteractiveSession");
  const externalEnd = source.indexOf("async function provisionInteractiveEndpoint", externalStart);
  const externalSource = source.slice(externalStart, externalEnd);
  const forwardedStart = source.indexOf("function provisionResultFromBody");
  const forwardedEnd = source.indexOf("function failedProvision", forwardedStart);
  const forwardedSource = source.slice(forwardedStart, forwardedEnd);

  assert.match(externalSource, /createOnlyAdapterStatus\(body\.status\)/);
  assert.match(forwardedSource, /createOnlyAdapterStatus\(body\.status\)/);
  assert.match(forwardedSource, /if \(!status\) return failedProvision/);
});

test("Sandbox cleanup and legacy stops use durable terminal transitions", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const actionStart = source.indexOf('if (action === "stop")');
  const actionEnd = source.indexOf('throw badRequest("unknown action")', actionStart);
  const stopSource = source.slice(actionStart, actionEnd);
  const legacyCompleteIndex = stopSource.indexOf("completeLegacyInteractiveSessionStop");
  const cleanupIndex = stopSource.lastIndexOf(
    "stageTerminalCredentialPolicyCleanupById",
    legacyCompleteIndex,
  );
  const reconcileIndex = stopSource.indexOf("reconcileCredentialPolicyCleanupBatch", cleanupIndex);
  const completeStart = source.indexOf("async function completeLegacyInteractiveSessionStop");
  const completeEnd = source.indexOf("async function mutateInteractiveSession(", completeStart);
  const completeSource = source.slice(completeStart, completeEnd);
  const scheduledStart = source.indexOf(
    "async function reconcileLegacyStoppingInteractiveSessionBatch",
  );
  const scheduledEnd = source.indexOf(
    "async function requeueTerminalArchiveObjectBackfill",
    scheduledStart,
  );
  const scheduledSource = source.slice(scheduledStart, scheduledEnd);

  assert.ok(actionStart >= 0 && actionEnd > actionStart);
  assert.ok(
    cleanupIndex >= 0 && reconcileIndex > cleanupIndex && legacyCompleteIndex > reconcileIndex,
  );
  assert.match(stopSource, /const staged = await stageTerminalCredentialPolicyCleanupById/);
  assert.match(stopSource, /if \(!staged\)/);
  assert.match(stopSource, /credential_cleanup_terminal_status/);
  assert.match(
    stopSource,
    /completeLegacyInteractiveSessionStop\(env, session, actor\(user\), now\)/,
  );
  assert.match(completeSource, /env\.DB\.batch/);
  assert.match(completeSource, /interactive workspace stop requested/);
  assert.match(completeSource, /interactive workspace stopped/);
  assert.match(completeSource, /status: "stopped"/);
  assert.match(completeSource, /terminal_finalize_pending: 1/);
  assert.match(completeSource, /AND status = \$\{owner\.status\}/);
  assert.match(completeSource, /AND updated_at = \$\{owner\.updatedAt\}/);
  assert.match(completeSource, /finalizeTerminalInteractiveSession/);
  assert.doesNotMatch(completeSource, /status: "stopping"/);
  assert.match(scheduledSource, /where\("status", "=", "stopping"\)/);
  assert.match(scheduledSource, /\.where\("runtime", "!=", githubActionsRuntime\)/);
  assert.match(scheduledSource, /completeLegacyInteractiveSessionStop/);
  assert.match(completeSource, /if \(owner\.runtime === githubActionsRuntime\) return false/);
  assert.match(completeSource, /async function stopGitHubActionsSession/);
  assert.match(completeSource, /work_state: ""/);
  assert.match(completeSource, /work_phase: "session_ended"/);
  assert.match(completeSource, /workflow run not canceled/);
  assert.match(stopSource, /session\.runtime === githubActionsRuntime/);
  assert.match(stopSource, /stopGitHubActionsSession\(env, session, userActor, now\)/);
  assert.match(stopSource, /interactive session lifecycle changed; retry stop/);
  assert.match(stopSource, /const current = await readInteractiveSession\(env, id\)/);
  assert.match(stopSource, /current\.adapter !== runtimeAdapterName/);
  assert.match(stopSource, /current\.adapterWorkspaceId !== session\.adapterWorkspaceId/);
  assert.match(stopSource, /\["stopping", "stopped", "expired", "failed"\]\.includes/);
});

test("legacy expiry enters the shared retryable terminal finalizer", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const expiryStart = source.indexOf("async function markInteractiveTerminalUnavailable");
  const expiryEnd = source.indexOf("async function uploadInteractiveSessionClipboard", expiryStart);
  const expirySource = source.slice(expiryStart, expiryEnd);

  assert.match(expirySource, /status: "expired"/);
  assert.match(expirySource, /MAX\(updated_at \+ 1, \$\{now\}\)/);
  assert.match(expirySource, /where\("updated_at", "=", existing\.updated_at\)/);
  assert.match(expirySource, /terminal_finalize_pending: 1/);
  assert.match(expirySource, /finalizeTerminalInteractiveSession\(env, id, "expired", now\)/);
  assert.match(expirySource, /stageTerminalCredentialPolicyCleanupById/);
  assert.match(
    expirySource,
    /stageTerminalCredentialPolicyCleanupById\([\s\S]*?"failed",\s*message,[\s\S]*?now,\s*message/,
  );
  assert.match(expirySource, /reconcileCredentialPolicyCleanupBatch\(env, now, id\)/);
  assert.ok(
    expirySource.indexOf("stageTerminalCredentialPolicyCleanup") <
      expirySource.indexOf("reconcileCredentialPolicyCleanupBatch"),
  );
});

test("idempotent legacy terminal stop verifies credential cleanup", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const actionStart = source.indexOf('if (action === "stop")');
  const legacyCompleteIndex = source.indexOf(
    "completeLegacyInteractiveSessionStop(env, session",
    actionStart,
  );
  const fastPathSource = source.slice(actionStart, legacyCompleteIndex);
  const unregisterStart = source.indexOf("async function unregisterSandboxCredentialPolicyLookup");
  const unregisterEnd = source.indexOf(
    "function sandboxCredentialPolicyRefQueries",
    unregisterStart,
  );
  const unregisterSource = source.slice(unregisterStart, unregisterEnd);

  assert.match(fastPathSource, /isSandboxInteractiveSession\(session\)/);
  assert.match(fastPathSource, /stageTerminalCredentialPolicyCleanup/);
  assert.match(fastPathSource, /reconcileCredentialPolicyCleanupBatch/);
  assert.match(unregisterSource, /if \(!stub\) throw serviceUnavailable/);
  assert.match(unregisterSource, /if \(!response\.ok\)/);
  assert.doesNotMatch(unregisterSource, /response\.status !== 404/);
  assert.match(unregisterSource, /sandbox credential policy cleanup failed/);
});

test("sandbox credential cleanup is durably staged and retried", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const migration = await readFile(
    new URL("../migrations/0022_credential_policy_cleanup.sql", import.meta.url),
    "utf8",
  );
  const stageStart = source.indexOf("async function stageTerminalCredentialPolicyCleanup");
  const stageEnd = source.indexOf("type CredentialPolicyScanRow", stageStart);
  const stageSource = source.slice(stageStart, stageEnd);
  const scanStart = stageEnd;
  const batchStart = source.indexOf(
    "async function reconcileCredentialPolicyCleanupBatch",
    scanStart,
  );
  const scanSource = source.slice(scanStart, batchStart);
  const batchEnd = source.indexOf("async function reconcileCredentialPolicyCleanup(", batchStart);
  const batchSource = source.slice(batchStart, batchEnd);
  const cleanupStart = batchEnd;
  const cleanupEnd = source.indexOf(
    "async function completeCredentialPolicyCleanupSession",
    cleanupStart,
  );
  const cleanupSource = source.slice(cleanupStart, cleanupEnd);
  const completionEnd = source.indexOf("function legacyInteractiveSessionLeaseId", cleanupEnd);
  const completionSource = source.slice(cleanupEnd, completionEnd);
  const provisionStart = source.indexOf("async function provisionWithSandbox");
  const provisionEnd = source.indexOf(
    "async function registerSandboxCredentialPolicy",
    provisionStart,
  );
  const provisionSource = source.slice(provisionStart, provisionEnd);
  const registerStart = provisionEnd;
  const registerEnd = source.indexOf("async function ensureSandboxCredentialPolicy", registerStart);
  const registerSource = source.slice(registerStart, registerEnd);
  const registrationLifecycleStart = source.indexOf(
    "function sandboxCredentialPolicyRegistrationQueries",
  );
  const registrationLifecycleSource = source.slice(registrationLifecycleStart, registerEnd);
  const finishStart = source.indexOf("async function finishSandboxCredentialPolicyRegistration");
  const finishEnd = source.indexOf(
    "async function abandonSandboxCredentialPolicyRegistration",
    finishStart,
  );
  const finishSource = source.slice(finishStart, finishEnd);
  const abandonEnd = source.indexOf("async function registerSandboxCredentialPolicy", finishEnd);
  const abandonSource = source.slice(finishEnd, abandonEnd);
  const scanDecisionStart = source.indexOf("function credentialPolicyScanRequiresCleanup");
  const scanDecisionEnd = source.indexOf(
    "async function normalizeCredentialPolicyCleanupGroups",
    scanDecisionStart,
  );
  const scanDecisionSource = source.slice(scanDecisionStart, scanDecisionEnd);
  const controlStart = source.indexOf("export class SessionControlDO");
  const controlEnd = source.indexOf("function dedupeSandboxPolicies", controlStart);
  const controlSource = source.slice(controlStart, controlEnd);
  const refreshStart = source.indexOf("async function ensureCurrentSandboxLease");
  const refreshEnd = source.indexOf("async function prepareSandboxWorkspace", refreshStart);
  const refreshSource = source.slice(refreshStart, refreshEnd);
  const ownershipStart = source.indexOf("function sandboxTerminalCleanupOwnership");
  const ownershipSource = source.slice(ownershipStart, stageStart);

  assert.match(stageSource, /executeBatch\(env, \[sessionTransition, \.\.\.policyTransitions\]\)/);
  assert.match(stageSource, /status: "stopping"/);
  assert.match(stageSource, /credential_cleanup_terminal_status: cleanupIntent/);
  assert.match(stageSource, /credential_cleanup_terminal_status = 'failed'/);
  assert.match(stageSource, /credential_cleanup_terminal_status = 'expired'/);
  assert.match(stageSource, /terminalCleanupIntentRank/);
  assert.match(stageSource, /sandbox_refresh_claim: null/);
  assert.match(stageSource, /sandboxManagedStoredOwnershipCondition\(ownership\.fence\)/);
  assert.match(stageSource, /where\("updated_at", "=", session\.updated_at\)/);
  assert.match(stageSource, /sandboxCredentialPolicyCleanupAuthorizedCondition/);
  assert.match(stageSource, /\.where\("sandbox_id", "=", sandboxId\)/);
  assert.match(stageSource, /agent_token_hash: null/);
  assert.match(stageSource, /controller: null/);
  assert.match(stageSource, /terminal_failure_reason:/);
  assert.match(stageSource, /failureReason/);
  assert.match(stageSource, /NULLIF\(terminal_failure_reason, ''\)/);
  assert.match(stageSource, /terminal_failure_reason: failureEvidence/);
  assert.match(stageSource, /state: "cleanup_pending"/);
  assert.match(stageSource, /for \(let attempt = 0; attempt < 3; attempt \+= 1\)/);
  assert.match(ownershipSource, /sandboxLeaseWithoutRefresh/);
  assert.match(ownershipSource, /sandbox_refresh_claim_expires_at/);
  assert.match(ownershipSource, /sandboxIds: \[\.\.\.new Set/);
  assert.match(scanSource, /credentialPolicyScanLimit/);
  assert.match(scanSource, /scan_max_rowid/);
  assert.match(scanSource, /maximumCredentialPolicyRowid/);
  assert.match(scanSource, /policy\.rowid > \$\{cursor\}/);
  assert.match(scanSource, /policy\.rowid <= \$\{maxRowid\}/);
  assert.doesNotMatch(scanSource, /affectedSessions/);
  assert.doesNotMatch(scanSource, /const transitioned = await update\.executeTakeFirst\(\)/);
  assert.match(scanSource, /const sessionTransition = sql/);
  assert.match(scanSource, /executeBatch\(env, \[sessionTransition, policyTransition\]\)/);
  assert.match(scanSource, /executeBatch\(env, \[ownerTransition, policyTransition\]\)/);
  assert.match(scanSource, /sandboxCredentialPolicyCleanupAuthorizedCondition/);
  assert.match(scanSource, /AND status IS \$\{row\.session_status\}/);
  assert.match(scanSource, /AND lease_id IS \$\{row\.session_lease_id\}/);
  assert.match(scanSource, /AND agent_token_hash IS \$\{row\.session_agent_token_hash\}/);
  assert.match(scanSource, /standalone\.ownership_claim AS standalone_claim/);
  assert.match(scanSource, /AND updated_at IS \$\{row\.session_updated_at\}/);
  assert.match(scanSource, /\.where\("sandbox_id", "=", row\.sandbox_id\)/);
  assert.match(scanSource, /\.where\("lookup_id", "=", row\.lookup_id\)/);
  assert.match(
    scanSource,
    /\.where\("registration_generation", "=", row\.registration_generation\)/,
  );
  assert.match(scanSource, /terminal_failure_reason = CASE/);
  assert.match(scanSource, /credential_cleanup_terminal_status = 'failed'/);
  assert.match(scanSource, /credential_cleanup_terminal_status = 'expired'/);
  assert.match(scanSource, /const transitionRevision = Math\.max/);
  assert.match(scanSource, /agent_token_hash = NULL/);
  assert.match(scanSource, /credentialPolicySandboxIsExpected/);
  assert.match(scanSource, /sandbox_refresh_claim = NULL/);
  assert.match(scanSource, /normalizeCredentialPolicyCleanupGroups/);
  assert.match(scanSource, /group_max_session_id/);
  assert.match(batchSource, /scanCredentialPolicyCleanupPage/);
  assert.match(batchSource, /normalizeCredentialPolicyCleanupGroups/);
  assert.match(batchSource, /COALESCE\(last_attempt_at, created_at\)/);
  assert.match(batchSource, /\.limit\(credentialPolicyCleanupLimit\)/);
  assert.match(batchSource, /completeStandaloneSandboxProvisionCleanupSafely/);
  assert.match(cleanupSource, /cleanup_claim_expires_at/);
  assert.match(cleanupSource, /registration_claim_expires_at > \$\{now\}/);
  assert.match(cleanupSource, /sandboxCredentialPolicyCleanupAuthorizedCondition/);
  assert.ok(
    cleanupSource.indexOf("cleanup_claim = ${claim}") <
      cleanupSource.indexOf("unregisterSandboxCredentialPolicyLookup"),
  );
  assert.match(cleanupSource, /last_error:/);
  assert.match(cleanupSource, /cleanup_claim: null/);
  assert.match(cleanupSource, /async function completeStandaloneSandboxProvisionCleanupSafely/);
  assert.match(cleanupSource, /standalone Sandbox cleanup pending/);
  assert.match(cleanupSource, /standalone_sandbox_provisions/);
  assert.match(cleanupSource, /MAX\(updated_at \+ 1, \$\{now\}\)/);
  assert.match(cleanupSource, /cleanup failure persistence failed/);
  assert.match(completionSource, /NOT EXISTS \(/);
  assert.match(completionSource, /status: terminalStatus/);
  assert.match(completionSource, /terminal_finalize_pending: 1/);
  assert.match(completionSource, /MAX\(updated_at \+ 1, \$\{now\}\)/);
  assert.match(completionSource, /\.where\("status", "=", session\.status\)/);
  assert.match(completionSource, /\.where\("updated_at", "=", session\.updated_at\)/);
  assert.match(completionSource, /retainedRuntimeAdapterFailureMessage/);
  assert.match(completionSource, /terminal_failure_reason:/);
  assert.match(completionSource, /\? failureMessage/);
  assert.match(batchSource, /completeCredentialPolicyCleanupSession\(env, session\.id/);
  assert.ok(
    provisionSource.indexOf("stageTerminalCredentialPolicyCleanupById") <
      provisionSource.indexOf("reconcileCredentialPolicyCleanupBatch"),
  );
  assert.match(provisionSource, /failureAt,\s*cleanupMessage,\s*ownershipFence/);
  assert.match(provisionSource, /try \{[\s\S]*sandboxProvisionPreflightError\(env, session\)/);
  assert.match(provisionSource, /!agentToken/);
  assert.match(provisionSource, /managed Sandbox agent token is unavailable/);
  assert.match(registrationLifecycleSource, /registration_generation/);
  assert.match(registrationLifecycleSource, /registration_claim/);
  assert.match(registrationLifecycleSource, /registration_claim_expires_at/);
  assert.doesNotMatch(registrationLifecycleSource, /ownershipFence\?:/);
  assert.doesNotMatch(registrationLifecycleSource, /1 = 1/);
  assert.match(registrationLifecycleSource, /sandboxCredentialPolicyOwnerCondition/);
  assert.match(registrationLifecycleSource, /sandboxCredentialPolicyOwnerCondition/);
  assert.ok(
    registerSource.indexOf("beginSandboxCredentialPolicyRegistration") <
      registerSource.indexOf(
        'stub.fetch("https://crabfleet.internal/api/session-control/register"',
      ),
  );
  assert.ok(
    registerSource.indexOf("renewSandboxCredentialPolicyRegistration") <
      registerSource.indexOf(
        'stub.fetch("https://crabfleet.internal/api/session-control/register"',
      ),
  );
  assert.ok(
    registerSource.indexOf('stub.fetch("https://crabfleet.internal/api/session-control/register"') <
      registerSource.indexOf("finishSandboxCredentialPolicyRegistration"),
  );
  assert.doesNotMatch(finishSource, /INSERT INTO|insertInto/);
  assert.match(finishSource, /state: "active"/);
  assert.match(finishSource, /where\(sandboxCredentialPolicyOwnerCondition/);
  assert.doesNotMatch(finishSource, /cleanup_pending/);
  assert.match(registerSource, /abandonSandboxCredentialPolicyRegistration/);
  assert.match(abandonSource, /sandboxCredentialPolicyCleanupAuthorizedCondition/);
  assert.match(abandonSource, /THEN 'cleanup_pending'/);
  assert.match(abandonSource, /ELSE 'registering'/);
  assert.ok(
    scanDecisionSource.indexOf("sandboxExpected") <
      scanDecisionSource.indexOf("if (registrationAbandoned) return true"),
  );
  assert.doesNotMatch(scanDecisionSource, /row\.session_agent_token_hash !== null/);
  assert.match(scanDecisionSource, /sandboxExpected &&[\s\S]*row\.session_status === "ready"/);
  assert.match(controlSource, /sandboxPolicyTombstoneKey/);
  assert.match(controlSource, /credentialPolicyRegistrationAccepted/);
  assert.match(controlSource, /credentialPolicyCleanupMatches/);
  assert.match(controlSource, /this\.ctx\.storage\.transaction/);
  assert.doesNotMatch(source, /async function unregisterSandboxCredentialPolicy\(/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS interactive_session_credential_policies/);
  assert.match(migration, /state IN \('registering', 'active', 'cleanup_pending'\)/);
  assert.match(migration, /registration_generation TEXT NOT NULL/);
  assert.match(migration, /registration_claim_expires_at INTEGER/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS credential_policy_reconcile_state/);
  assert.match(migration, /scan_max_rowid INTEGER NOT NULL/);
  assert.match(migration, /group_max_session_id TEXT NOT NULL/);
  assert.match(migration, /ADD COLUMN sandbox_refresh_sandbox_id TEXT/);
  assert.match(migration, /ADD COLUMN sandbox_refresh_claim TEXT/);
  assert.match(migration, /ADD COLUMN sandbox_refresh_claim_expires_at INTEGER/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS standalone_sandbox_provisions/);
  assert.match(migration, /idx_interactive_policy_fair_cleanup/);
  assert.match(migration, /COALESCE\(last_attempt_at, created_at\)/);
  assert.match(migration, /terminal_failure_reason = CASE/);
  assert.match(migration, /terminal_finalize_pending = 0/);
  assert.match(migration, /agent_token_hash = NULL/);
  assert.match(migration, /SET\s+status = 'stopping'/);
  assert.match(refreshSource, /sandbox_refresh_sandbox_id: refreshFence\.sandboxId/);
  assert.match(refreshSource, /sandbox_refresh_claim: refreshFence\.claim/);
  assert.match(refreshSource, /sandbox_refresh_claim_expires_at: refreshFence\.expiresAt/);
  assert.match(refreshSource, /const agentToken = newAgentToken\(\)/);
  assert.ok(
    refreshSource.indexOf("sandboxProvisionPreflightError(env, refreshPayload)") <
      refreshSource.indexOf("const agentToken = newAgentToken()"),
  );
  assert.match(refreshSource, /agent_token_hash: agentTokenHash/);
  assert.match(refreshSource, /provisionWithSandbox\([\s\S]*?agentToken,[\s\S]*?refreshLease/);
  assert.match(refreshSource, /where\("agent_token_hash", "=", agentTokenHash\)/);
  assert.match(refreshSource, /sandbox_refresh_claim_expires_at", "=", refreshFence\.expiresAt/);
  assert.match(refreshSource, /executeBatch\(env, commitQueries\)/);
  assert.match(refreshSource, /state: "cleanup_pending"/);
  assert.match(refreshSource, /stageFailedManagedSandboxProvision/);
  assert.ok(
    refreshSource.indexOf("sandbox_refresh_claim: null") <
      refreshSource.lastIndexOf("reconcileCredentialPolicyCleanupBatch"),
  );
  assert.doesNotMatch(
    refreshSource,
    /queueSandboxCredentialPolicyCleanup\(env, session\.id, oldSandboxId, refreshedAt\)/,
  );
  assert.match(refreshSource, /const current = await readInteractiveSession/);
});

test("terminal endpoints enforce current runtime capabilities", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const decorateStart = source.indexOf("function decorateInteractiveSession");
  const decorateEnd = source.indexOf(
    "function canChangeInteractiveSessionMultiplayer",
    decorateStart,
  );
  const decorateSource = source.slice(decorateStart, decorateEnd);
  const directPtyStart = source.indexOf("async function interactiveSessionPty");
  const directPtyEnd = source.indexOf("async function interactiveSandboxTerminal", directPtyStart);
  const directPtySource = source.slice(directPtyStart, directPtyEnd);

  assert.match(source, /type InteractiveSession = \{[\s\S]*ptyAvailable\?: boolean;/);
  assert.match(source, /if \(!session\.capabilities\.terminal\)/);
  assert.match(source, /runtimeCapabilities\(row\.runtime, row\.capabilities_json\)\.terminal/);
  assert.match(source, /runtimeAdapterTerminalFailureStatus\(existing\.adapter\) === "detached"/);
  assert.match(source, /attachUrl: capabilities\.terminal \? row\.attach_url : null/);
  assert.match(decorateSource, /const routeKind = interactivePtyRouteKind\(env, session\)/);
  assert.match(decorateSource, /interactiveTerminalTarget\(env, session, routeKind\)/);
  assert.match(decorateSource, /routeAvailable/);
  assert.match(
    decorateSource,
    /const proxyManagedTerminal =[\s\S]*session\.runtime === githubActionsRuntime \|\|[\s\S]*session\.adapter === runtimeAdapterName/,
  );
  assert.match(
    decorateSource,
    /const attachUrl = proxyManagedTerminal[\s\S]*\? ptyAvailable[\s\S]*`\/api\/interactive-sessions\/\$\{encodeURIComponent\(session\.id\)\}\/pty`[\s\S]*: null/,
  );
  assert.match(directPtySource, /session\.runtime === githubActionsRuntime/);
  assert.match(directPtySource, /openInteractiveTerminalUpstream\(/);
  assert.match(decorateSource, /attachUrl,/);
  assert.doesNotMatch(
    decorateSource,
    /attachUrl: canControl && session\.capabilities\.terminal \? session\.attachUrl : null/,
  );
});

test("non-retryable adapter client errors do not enter ambiguous replay", () => {
  assert.equal(definitiveRuntimeAdapterCreateFailure(413), true);
  assert.equal(definitiveRuntimeAdapterCreateFailure(415), true);
  assert.equal(definitiveRuntimeAdapterCreateFailure(422), true);
  assert.equal(definitiveRuntimeAdapterCreateFailure(408), false);
  assert.equal(definitiveRuntimeAdapterCreateFailure(409), false);
  assert.equal(definitiveRuntimeAdapterCreateFailure(423), false);
  assert.equal(definitiveRuntimeAdapterCreateFailure(425), false);
  assert.equal(definitiveRuntimeAdapterCreateFailure(429), false);
  assert.equal(definitiveRuntimeAdapterCreateFailure(503), false);
});

test("explicit workspace id conflicts are distinct from retryable 409 responses", () => {
  assert.equal(
    runtimeAdapterWorkspaceIdConflict(409, {
      error: { code: "workspace_id_conflict", message: "workspace id is already owned" },
    }),
    true,
  );
  assert.equal(runtimeAdapterWorkspaceIdConflict(409, { error: { code: "busy" } }), false);
  assert.equal(
    runtimeAdapterWorkspaceIdConflict(422, { error: { code: "workspace_id_conflict" } }),
    false,
  );
});

test("workspace id conflicts detach without adopting or deleting the existing workspace", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const createStart = source.indexOf("async function provisionWithRuntimeAdapter");
  const createEnd = source.indexOf("function persistedRuntimeAdapterSeconds", createStart);
  const createSource = source.slice(createStart, createEnd);
  const conflictStart = source.indexOf("async function failRuntimeAdapterWorkspaceIdConflict");
  const conflictEnd = source.indexOf(
    "async function releaseFailedRuntimeAdapterProvision",
    conflictStart,
  );
  const conflictSource = source.slice(conflictStart, conflictEnd);
  const stageStart = source.indexOf("async function stageRuntimeAdapterProvision");
  const stageEnd = source.indexOf("function ambiguousRuntimeAdapterProvision", stageStart);
  const stageSource = source.slice(stageStart, stageEnd);
  const stoppingReplayStart = source.indexOf("async function replayStoppingRuntimeAdapterCreate");
  const stoppingReplayEnd = source.indexOf(
    "async function stopRuntimeAdapterWorkspace(",
    stoppingReplayStart,
  );
  const stoppingReplaySource = source.slice(stoppingReplayStart, stoppingReplayEnd);

  assert.ok(
    createSource.indexOf("runtimeAdapterWorkspaceIdConflict") <
      createSource.indexOf("definitiveRuntimeAdapterCreateFailure"),
  );
  assert.match(createSource, /failRuntimeAdapterWorkspaceIdConflict/);
  assert.match(
    createSource,
    /throw conflict\("runtime adapter workspace conflict response is stale"\)/,
  );
  assert.match(stageSource, /updated_at: sql<number>`MAX\(updated_at \+ 1, \$\{stageAt\}\)`/);
  assert.match(
    stageSource,
    /returning\(\["status", "updated_at", "last_reconciled_at", "terminal_status"\]\)/,
  );
  assert.match(stageSource, /last_reconciled_at", "=", reconciliationOwner\.lastReconciledAt/);
  assert.match(conflictSource, /adapter: null/);
  assert.match(conflictSource, /adapter_workspace_id: null/);
  assert.match(conflictSource, /adapter_control_plane: null/);
  assert.match(conflictSource, /adapter_create_payload_json: null/);
  assert.match(conflictSource, /adapter_create_pending: 0/);
  assert.match(conflictSource, /AND adapter_create_pending = 1/);
  assert.match(conflictSource, /AND status = \$\{createAttempt\.status\}/);
  assert.match(conflictSource, /AND updated_at = \$\{createAttempt\.updatedAt\}/);
  assert.match(conflictSource, /AND \$\{lastReconciledOwner\}/);
  assert.match(conflictSource, /AND \$\{terminalStatusOwner\}/);
  assert.match(conflictSource, /if \(!results\.at\(-1\)\?\.results\.length\) return null/);
  assert.match(conflictSource, /terminal_finalize_pending: 1/);
  assert.match(conflictSource, /env\.DB\.batch/);
  assert.match(
    conflictSource,
    /finalizeTerminalInteractiveSession\(env, session\.id, "failed", now\)/,
  );
  assert.doesNotMatch(conflictSource, /stopRuntimeAdapterWorkspace/);
  assert.match(stoppingReplaySource, /runtimeAdapterWorkspaceIdConflict/);
  assert.match(stoppingReplaySource, /terminalResult/);
  assert.doesNotMatch(stoppingReplaySource, /definitiveRuntimeAdapterCreateFailure/);
});

test("definitive adapter create errors retain a redacted provider reason before release", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const createStart = source.indexOf("async function provisionWithRuntimeAdapter");
  const createEnd = source.indexOf("function persistedRuntimeAdapterSeconds", createStart);
  const createSource = source.slice(createStart, createEnd);
  const replayStart = source.indexOf("async function replayStoppingRuntimeAdapterCreate");
  const replayEnd = source.indexOf("async function stopRuntimeAdapterWorkspace", replayStart);
  const replaySource = source.slice(replayStart, replayEnd);
  const releaseStart = source.indexOf("async function releaseFailedRuntimeAdapterProvision");
  const releaseEnd = source.indexOf(
    "async function persistRuntimeAdapterStopEvidence",
    releaseStart,
  );
  const releaseSource = source.slice(releaseStart, releaseEnd);
  const bodyStart = source.indexOf("async function readRuntimeAdapterResponseBody");
  const bodyEnd = source.indexOf("function runtimeAdapterToken", bodyStart);
  const bodySource = source.slice(bodyStart, bodyEnd);

  const bodyReadIndex = createSource.indexOf(
    "responseBody = await readRuntimeAdapterResponseBody(response)",
  );
  assert.ok(bodyReadIndex >= 0 && bodyReadIndex < createSource.indexOf("if (!response.ok)"));
  assert.match(createSource, /redactedAdapterResponseMessage/);
  assert.match(createSource, /runtime adapter provision failed: \$\{responseMessage\}/);
  assert.match(createSource, /releaseFailedRuntimeAdapterProvision/);
  assert.doesNotMatch(createSource, /response\.json/);
  assert.match(replaySource, /readRuntimeAdapterResponseBody\(response\)/);
  assert.match(replaySource, /redactedAdapterResponseMessage/);
  assert.match(replaySource, /reconcile_error: message/);
  assert.match(replaySource, /INSERT INTO interactive_session_events/);
  assert.doesNotMatch(replaySource, /response\.json/);
  assert.ok(
    releaseSource.indexOf("stageFailedRuntimeAdapterRelease") <
      releaseSource.indexOf("stopRuntimeAdapterWorkspaceForSession"),
  );
  assert.match(bodySource, /await readBoundedResponseText\(response\)/);
  assert.doesNotMatch(bodySource, /response\.(?:json|text)\(/);
  assert.match(bodySource, /JSON\.parse\(body\)/);
  assert.equal(
    redactedAdapterResponseMessage(
      { detail: "capacity unavailable; token=private-value" },
      "HTTP 422",
    ),
    "capacity unavailable; [credential]",
  );
  const opaqueErrorIds = ["provider-body", "provider-workspace", "provider-error"];
  const opaqueErrorMessage = redactedAdapterResponseMessage(
    {
      providerResourceId: opaqueErrorIds[0],
      workspace: { provider_resource_id: opaqueErrorIds[1] },
      error: {
        leaseId: opaqueErrorIds[2],
        message: `failed ${opaqueErrorIds.join(" ")}`,
      },
    },
    "HTTP 422",
  );
  assert.equal(opaqueErrorMessage, "failed [workspace] [workspace] [workspace]");
  for (const identifier of opaqueErrorIds) {
    assert.doesNotMatch(opaqueErrorMessage, new RegExp(identifier));
  }
});

test("successful DELETE requires an implicit or parsed release confirmation", () => {
  const ready = parseAdapterWorkspaceResult({ id: "fleet-a-is-101", status: "ready" });
  const stopped = parseAdapterWorkspaceResult({ id: "fleet-a-is-101", status: "stopped" });
  const wrong = parseAdapterWorkspaceResult({ id: "fleet-b-is-101", status: "stopped" });
  assert.equal(runtimeAdapterStopOutcome(200, null, "fleet-a-is-101"), "stopping");
  assert.equal(runtimeAdapterStopOutcome(202, null, "fleet-a-is-101"), "stopping");
  assert.equal(runtimeAdapterStopOutcome(200, ready, "fleet-a-is-101"), "stopping");
  assert.equal(runtimeAdapterStopOutcome(200, stopped, "fleet-a-is-101"), "stopped");
  assert.equal(runtimeAdapterStopOutcome(204, null, "fleet-a-is-101"), "stopped");
  assert.equal(runtimeAdapterStopOutcome(200, wrong, "fleet-a-is-101"), "identity_mismatch");
});

test("adapter DELETE evidence survives pending and confirmed release", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const deleteStart = source.indexOf("async function stopRuntimeAdapterWorkspace(");
  const deleteEnd = source.indexOf("async function runtimeAdapterFetch", deleteStart);
  const deleteSource = source.slice(deleteStart, deleteEnd);
  const reconcileStart = source.indexOf("async function reconcileStoppingRuntimeAdapterWorkspace");
  const reconcileEnd = source.indexOf("type StoppingRuntimeAdapterReplay", reconcileStart);
  const reconcileSource = source.slice(reconcileStart, reconcileEnd);
  const releaseStart = source.indexOf("async function recordConfirmedRuntimeAdapterRelease");
  const releaseEnd = source.indexOf(
    "async function clearRuntimeAdapterCreatePending",
    releaseStart,
  );
  const releaseSource = source.slice(releaseStart, releaseEnd);
  const failedReleaseStart = source.indexOf("async function releaseFailedRuntimeAdapterProvision");
  const failedReleaseEnd = source.indexOf(
    "async function stageFailedRuntimeAdapterRelease",
    failedReleaseStart,
  );
  const failedReleaseSource = source.slice(failedReleaseStart, failedReleaseEnd);

  assert.match(deleteSource, /await readRuntimeAdapterResponseBody\(response\)/);
  assert.doesNotMatch(deleteSource, /response\.json/);
  assert.match(deleteSource, /redactedAdapterResponseMessage/);
  assert.match(deleteSource, /return \{ status: "stopped", message \}/);
  assert.match(deleteSource, /return \{ status: outcome, message \}/);
  assert.match(reconcileSource, /runtime adapter stop pending: \$\{safeProviderError/);
  assert.match(reconcileSource, /reconcileError: message/);
  assert.match(reconcileSource, /release\.message/);
  assert.match(releaseSource, /retainedReleaseMessage/);
  assert.match(releaseSource, /env\.DB\.batch/);
  assert.match(releaseSource, /INSERT INTO interactive_session_events/);
  assert.match(releaseSource, /terminal_finalize_pending: 1/);
  assert.match(failedReleaseSource, /persistRuntimeAdapterStopEvidence/);
  assert.match(failedReleaseSource, /await executeBatch\(env, \[/);
  assert.match(failedReleaseSource, /INSERT INTO interactive_session_events/);
  assert.match(failedReleaseSource, /AND NOT EXISTS/);
});

test("adapter workspace paths use the controller id and encode it", () => {
  assert.equal(normalizeAdapterWorkspaceId("IS-101"), "is-101");
  assert.equal(
    runtimeAdapterWorkspaceUrl("https://controller.example/base", "session/one"),
    "https://controller.example/base/v1/workspaces/session%2Fone",
  );
  assert.equal(
    runtimeAdapterDesktopUrl("https://controller.example/base", "is-101"),
    "https://controller.example/base/v1/workspaces/is-101/connections/desktop",
  );
  assert.equal(
    runtimeAdapterBrowserVncUrl("https://fleet.example", "IS/101"),
    "https://fleet.example/api/interactive-sessions/IS%2F101/vnc",
  );
});

test("runtime adapter control-plane identity is canonical and origin-bound", () => {
  assert.equal(
    runtimeAdapterControlPlaneIdentity("https://controller.example/api/"),
    "https://controller.example/api",
  );
  assert.equal(
    runtimeAdapterControlPlaneIdentity("https://controller.example"),
    "https://controller.example/",
  );
  assert.equal(runtimeAdapterControlPlaneIdentity("https://controller.example/api?tenant=a"), null);
  assert.equal(runtimeAdapterControlPlaneIdentity("https://controller.example/api?"), null);
  assert.equal(runtimeAdapterControlPlaneIdentity("https://controller.example/api#fragment"), null);
  assert.equal(runtimeAdapterControlPlaneIdentity("https://controller.example/api#"), null);
  assert.equal(runtimeAdapterControlPlaneIdentity("http://controller.example/api"), null);
  assert.equal(
    runtimeAdapterControlPlaneIdentity("http://127.0.0.1:8788/adapter/"),
    "http://127.0.0.1:8788/adapter",
  );
  assert.equal(
    runtimeAdapterWorkspaceUrl("https://controller.example/root/adapter", "fleet-is-1"),
    "https://controller.example/root/adapter/v1/workspaces/fleet-is-1",
  );
});

test("runtime adapter profile routes expand one allowlisted path segment", () => {
  assert.equal(
    runtimeAdapterControlPlaneForProfile(
      undefined,
      "https://controller.example/v1/adapters/{profile}/proxy/",
      "linux-desktop",
    ),
    "https://controller.example/v1/adapters/linux-desktop/proxy",
  );
  assert.equal(
    runtimeAdapterControlPlaneForProfile(
      undefined,
      "https://controller.example/v1/adapters/{profile}/proxy",
      "macos-desktop",
    ),
    "https://controller.example/v1/adapters/macos-desktop/proxy",
  );
  assert.equal(
    runtimeAdapterControlPlaneForProfile(
      "https://controller.example/default",
      undefined,
      "legacy.profile",
    ),
    "https://controller.example/default",
  );
  assert.equal(
    runtimeAdapterControlPlaneForProfile(
      "https://controller.example/default",
      "https://controller.example/{profile}",
      "linux-desktop",
    ),
    null,
  );
  assert.equal(
    runtimeAdapterControlPlaneForProfile(
      undefined,
      "https://{profile}.controller.example/proxy",
      "linux-desktop",
    ),
    null,
  );
  assert.equal(
    runtimeAdapterControlPlaneForProfile(undefined, "https://{profile}/proxy", "linux-desktop"),
    null,
  );
  assert.equal(
    runtimeAdapterControlPlaneForProfile(
      undefined,
      "https://controller.example/{profile}/proxy?tenant=fleet",
      "linux-desktop",
    ),
    null,
  );
  assert.equal(
    runtimeAdapterControlPlaneForProfile(
      undefined,
      "https://controller.example/{profile}/{profile}",
      "linux-desktop",
    ),
    null,
  );
  assert.equal(
    runtimeAdapterControlPlaneForProfile(
      undefined,
      "https://controller.example/{profile}/proxy",
      "macos_desktop",
    ),
    null,
  );
});

test("adapter bodies share the bounded stream reader", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const ranges = [
    ["async function provisionWithRuntimeAdapter", "function persistedRuntimeAdapterSeconds"],
    [
      "async function inspectRuntimeAdapterWorkspace",
      "async function reconcileStoppingRuntimeAdapterWorkspace",
    ],
    [
      "async function replayStoppingRuntimeAdapterCreate",
      "async function stopRuntimeAdapterWorkspace(",
    ],
    ["async function stopRuntimeAdapterWorkspace(", "type RuntimeAdapterStopResult"],
    ["async function interactiveSessionVnc", "function interactiveTerminalTarget"],
  ] as const;
  for (const [startMarker, endMarker] of ranges) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    const operation = source.slice(start, end);
    assert.match(operation, /readRuntimeAdapterResponseBody\(response\)/);
    assert.doesNotMatch(operation, /response\.(?:json|text)\(/);
  }
  const readerStart = source.indexOf("async function readRuntimeAdapterResponseBody");
  const readerEnd = source.indexOf("function runtimeAdapterToken", readerStart);
  const readerSource = source.slice(readerStart, readerEnd);
  assert.match(readerSource, /readBoundedResponseText\(response\)/);
  assert.doesNotMatch(readerSource, /response\.(?:json|text)\(/);
});

test("desktop mint revalidates current ownership before redirect", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const vncStart = source.indexOf("async function interactiveSessionVnc");
  const vncEnd = source.indexOf("function interactiveTerminalTarget", vncStart);
  const vncSource = source.slice(vncStart, vncEnd);

  assert.ok(
    vncSource.indexOf("currentAdapterDesktopConnection") <
      vncSource.indexOf("currentRuntimeAdapterDesktopAccess"),
  );
  assert.ok(
    vncSource.indexOf("currentRuntimeAdapterDesktopAccess") <
      vncSource.indexOf("target = connection.url"),
  );
  assert.match(vncSource, /selectFrom\("interactive_sessions"\)/);
  assert.match(vncSource, /adapter_workspace_id/);
  assert.match(vncSource, /adapter_control_plane/);
  assert.match(vncSource, /provider_resource_id/);
  assert.match(vncSource, /adapter_create_pending/);
  assert.match(vncSource, /\["ready", "attached", "detached"\]/);
  assert.match(vncSource, /current\.capabilities\.vnc/);
  assert.match(vncSource, /current\.capabilities\.desktop/);
  assert.match(vncSource, /canControlInteractiveSession/);
  assert.match(vncSource, /desktop authorization changed; retry/);
  assert.doesNotMatch(vncSource, /body:\s*JSON\.stringify\(\{\}\)/);
});

test("runtime adapter terminals use the server-side adapter bearer", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const targetStart = source.indexOf("function interactiveTerminalTarget");
  const targetEnd = source.indexOf("function interactivePtyRouteKind", targetStart);
  const targetSource = source.slice(targetStart, targetEnd);

  assert.match(targetSource, /session\.adapter === runtimeAdapterName/);
  assert.match(targetSource, /session\[interactiveSessionAdapterControlPlane\]/);
  assert.match(targetSource, /runtimeAdapterTerminalAuthorization/);
  assert.match(targetSource, /requireRegisteredRuntimeAdapterControlPlane/);
  assert.match(targetSource, /runtimeAdapterTerminalOriginMatches\(controlPlane, attachUrl\)/);
  assert.match(targetSource, /bearer\(runtimeAdapterToken\(env\)\)/);
  assert.doesNotMatch(targetSource, /searchParams\.set\([^)]*(?:token|ticket)/u);
  const decorateStart = source.indexOf("function decorateInteractiveSession");
  const decorateEnd = source.indexOf(
    "function canChangeInteractiveSessionMultiplayer",
    decorateStart,
  );
  const decorateSource = source.slice(decorateStart, decorateEnd);
  assert.match(decorateSource, /interactiveTerminalTarget\(env, session, routeKind\)/);
  assert.match(decorateSource, /routeAvailable/);
});

test("runtime adapter terminal flow control stays explicit and end-to-end", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

  assert.match(source, /frame\.type === TerminalMessageType\.Ack/);
  assert.match(source, /subscription\.outputAcknowledgements/);
  assert.match(source, /bytes <= subscription\.outputAcknowledgementBytes/);
  assert.match(source, /acknowledgedBytes <= rightOutputAcknowledgementBytes/);
  assert.match(source, /TerminalSubscribeFlags\.OutputAcknowledgements/);
  assert.match(source, /searchParams\.get\("flow"\) === "ack-v1"/);
  assert.match(source, /JSON\.stringify\(\{ type: "ack", bytes \}\)/);
  assert.match(source, /terminalOutputAcknowledgement\(forwarded\)/);
  assert.match(source, /else if \(upstreamConnection\.outputAcknowledgements\)/);
});

test("runtime adapter terminal bearer stays on the registered origin", () => {
  assert.equal(
    runtimeAdapterTerminalOriginMatches(
      "https://controller.example/adapter",
      "wss://controller.example/v1/workspaces/fleet-is-101/terminal",
    ),
    true,
  );
  assert.equal(
    runtimeAdapterTerminalOriginMatches(
      "http://127.0.0.1:8788/adapter",
      "ws://127.0.0.1:8788/v1/workspaces/fleet-is-101/terminal",
    ),
    true,
  );
  assert.equal(
    runtimeAdapterTerminalOriginMatches(
      "https://controller.example/adapter",
      "wss://terminal.example/v1/workspaces/fleet-is-101/terminal",
    ),
    false,
  );
  assert.equal(
    runtimeAdapterTerminalOriginMatches(
      "https://controller.example/adapter",
      "wss://controller.example:8443/v1/workspaces/fleet-is-101/terminal",
    ),
    false,
  );
});

test("desktop redirects require HTTPS or literal loopback HTTP", () => {
  assert.equal(
    safeDesktopUrl("https://desktop.example/session"),
    "https://desktop.example/session",
  );
  assert.equal(safeDesktopUrl("http://127.0.0.1:6080/vnc"), "http://127.0.0.1:6080/vnc");
  assert.equal(safeDesktopUrl("http://localhost:6080/vnc"), "http://localhost:6080/vnc");
  assert.equal(safeDesktopUrl("http://desktop.example/vnc"), null);
  assert.equal(safeDesktopUrl("http://2130706433:6080/vnc"), null);
  assert.equal(safeDesktopUrl("https://user:secret@desktop.example/vnc"), null);
  assert.equal(safeDesktopUrl("javascript:alert(1)"), null);
  assert.equal(safeDesktopUrl(" https://desktop.example/vnc"), null);
  const signed = "https://Desktop.Example:443/%7Edesktop?signature=a%2Bb%2Fc%3D&dup=1&dup=2";
  assert.equal(safeDesktopUrl(signed), signed);
  assert.equal(parseAdapterDesktopConnection({ url: signed })?.url, signed);
});

test("terminal URLs require WSS except literal loopback WS", () => {
  assert.equal(
    safeWebSocketUrl("wss://terminal.example/session"),
    "wss://terminal.example/session",
  );
  assert.equal(safeWebSocketUrl("ws://localhost:8787/session"), "ws://localhost:8787/session");
  assert.equal(safeWebSocketUrl("ws://127.0.0.1:8787/session"), "ws://127.0.0.1:8787/session");
  assert.equal(safeWebSocketUrl("ws://terminal.example/session"), null);
  assert.equal(safeWebSocketUrl("ws://127.1:8787/session"), null);
  assert.equal(safeWebSocketUrl("wss://terminal.example/session\n"), null);
  const signed = "wss://Terminal.Example:443/%7Epty?signature=a%2Bb%2Fc%3D&dup=1&dup=2";
  assert.equal(safeWebSocketUrl(signed), signed);
  assert.equal(
    parseAdapterWorkspaceResult({ status: "ready", attachUrl: signed })?.terminalUrl,
    signed,
  );
  const message = parseAdapterWorkspaceResult({
    id: "fleet-a-is-101",
    status: "ready",
    attachUrl: signed,
    message: `attach ${signed}; Authorization: Bearer bearer-secret; token=query-secret`,
  })?.message;
  assert.equal(message, "attach [connection] [credential]");
  assert.doesNotMatch(message ?? "", /bearer-secret|query-secret|signature=/u);
  const slashEscaped = signed.replaceAll("/", "\\/");
  const nestedEscaped = JSON.stringify(slashEscaped).slice(1, -1);
  for (const escaped of [slashEscaped, nestedEscaped]) {
    const redacted = redactedAdapterMessage(`provider terminal ${escaped}`, "failed", [], [signed]);
    assert.equal(redacted, "provider terminal [connection]");
    assert.doesNotMatch(redacted, /signature|Terminal\.Example/iu);
  }
  for (const arbitrary of [
    String.raw`failed https:\/\/host.example\/pty?bearer=path-secret`,
    String.raw`nested {\"detail\":\"wss:\\/\\/host.example\\/pty?token=nested-secret\"}`,
    String.raw`mixed ws:\/\/host.example\/pty?authorization=Bearer-query-secret`,
  ]) {
    const redacted = redactedAdapterMessage(arbitrary, "failed");
    assert.match(redacted, /\[connection\]/u);
    assert.doesNotMatch(redacted, /host\.example|path-secret|nested-secret|query-secret/iu);
  }
  assert.equal(
    redactedAdapterResponseMessage(
      {
        message: `desktop ${slashEscaped}`,
        desktopUrl: signed.replace("wss://", "https://"),
        terminalUrl: signed,
      },
      "fallback",
    ),
    "desktop [connection]",
  );
  assert.equal(
    redactedAdapterMessage(
      "desktop https://desktop.example/vnc?ticket=secret and sig=second-secret",
      "ready",
    ),
    "desktop [connection] and [credential]",
  );
  const structured = redactedAdapterMessage(
    `provider {"token":"json-secret","ticket":"ticket-secret","safe":"ok"}; Authorization: Basic dXNlcjpwYXNz`,
    "failed",
  );
  assert.doesNotMatch(
    structured,
    /json-secret|ticket-secret|dXNlcjpwYXNz|access_token|refresh_token/iu,
  );
  assert.match(structured, /\[credential\]/u);
  for (const providerMessage of [
    `X-Api-Key: colon-secret`,
    `access_token: quoted-secret`,
    String.raw`escaped {\"refresh_token\":\"escaped-secret\"}`,
    `password=pass-secret; code: code-secret`,
  ]) {
    const redacted = redactedAdapterMessage(providerMessage, "failed");
    assert.doesNotMatch(
      redacted,
      /colon-secret|quoted-secret|escaped-secret|pass-secret|code-secret/iu,
    );
  }
  const opaqueIdentifierCollision = redactedAdapterMessage(
    "provider token=identifier-hidden-secret",
    "failed",
    ["token"],
  );
  assert.equal(opaqueIdentifierCollision, "provider [credential]");
  assert.doesNotMatch(opaqueIdentifierCollision, /identifier-hidden-secret/u);
});

test("desktop connection parser accepts current controller response aliases", () => {
  assert.deepEqual(
    parseAdapterDesktopConnection({
      vncUrl: "https://desktop.example/session?ticket=short-lived",
      expiresAt: 1_800_000_000,
    }),
    {
      url: "https://desktop.example/session?ticket=short-lived",
      expiresAt: 1_800_000_000_000,
      expiresAtPresent: true,
    },
  );
});

test("desktop connection expiry is optional but bounded when present", () => {
  const now = 1_800_000_000_000;
  const url = "https://desktop.example/session?ticket=transient";
  assert.equal(currentAdapterDesktopConnection({ url }, now)?.url, url);
  assert.equal(
    currentAdapterDesktopConnection({ url, expiresAt: now + 60_000 }, now)?.expiresAt,
    now + 60_000,
  );
  assert.equal(currentAdapterDesktopConnection({ url, expiresAt: now }, now), null);
  assert.equal(currentAdapterDesktopConnection({ url, expiresAt: now + 16 * 60_000 }, now), null);
  assert.equal(currentAdapterDesktopConnection({ url, expiresAt: "not-a-date" }, now), null);
  assert.equal(parseAdapterDesktopConnection({ url, expiresAt: "" }), null);
  assert.equal(parseAdapterDesktopConnection({ url, expiresAt: null })?.expiresAtPresent, false);
});
