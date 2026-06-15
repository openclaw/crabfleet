import { exactSecureHttpUrl, exactSecureWebSocketUrl } from "./url-security.ts";

export const runtimeAdapterVersion = "crabfleet/v1";
export const runtimeAdapterName = "runtime-v1";
export const runtimeAdapterDesktopMaxTtlMs = 15 * 60 * 1000;
const runtimeAdapterProfileRoutePlaceholder = "{profile}";
const runtimeAdapterProfileRoutePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type AdapterSessionStatus =
  | "provisioning"
  | "pending_adapter"
  | "ready"
  | "attached"
  | "detached"
  | "stopping"
  | "stopped"
  | "expired"
  | "failed";

export type AdapterCapabilities = {
  terminal: boolean;
  takeover: boolean;
  vnc: boolean;
  desktop: boolean;
  logs: boolean;
  artifacts: boolean;
};

export const clearedAdapterCapabilities: AdapterCapabilities = {
  terminal: false,
  takeover: false,
  vnc: false,
  desktop: false,
  logs: false,
  artifacts: false,
};

export type AdapterWorkspaceResult = {
  status: AdapterSessionStatus;
  workspaceId: string | null;
  reportedWorkspaceId: string | null;
  providerResourceId: string | null;
  terminalUrl: string | null;
  terminalUrlPresent: boolean;
  capabilities: AdapterCapabilities | null;
  capabilitiesPresent: boolean;
  capabilitiesOverlay?: Partial<AdapterCapabilities> | null;
  terminalCapabilityInferred?: boolean;
  expiresAt: number | null;
  expiresAtPresent: boolean;
  profile: string | null;
  message: string;
};

export type AdapterDesktopConnection = {
  url: string;
  expiresAt: number | null;
  expiresAtPresent: boolean;
};

export type AdapterCreateInput = {
  namespace: string;
  id: string;
  parentSessionId: string | null;
  rootSessionId: string | null;
  repo: string;
  branch: string;
  runtime: "crabbox" | "container";
  profile: string;
  command: string;
  prompt: string;
  purpose: string;
  summary: string;
  owner: string;
  createdBy: string;
  ttlSeconds: number;
  idleTimeoutSeconds: number;
  desktop: boolean;
};

export type AdapterProvisionRecord = {
  id: string;
  adapter_workspace_id: string | null;
  adapter_control_plane: string | null;
  parent_session_id: string | null;
  root_session_id: string | null;
  repo: string;
  branch: string;
  runtime: "crabbox" | "container";
  profile: string;
  command: string;
  prompt: string;
  purpose: string;
  summary: string;
  owner: string;
  created_by: string;
  adapter_ttl_seconds: number | null;
  adapter_idle_timeout_seconds: number | null;
  adapter_requested_capabilities_json: string | null;
  adapter_create_payload_json: string | null;
};

export type AdapterProvisionRequest = {
  id: string;
  adapterWorkspaceId: string | null;
  adapterControlPlane: string | null;
  parentSessionId: string | null;
  rootSessionId: string;
  repo: string;
  branch: string;
  runtime: "crabbox" | "container";
  profile: string;
  command: string;
  prompt: string;
  purpose: string;
  summary: string;
  owner: string;
  createdBy: string;
  adapterTtlSeconds: number | null;
  adapterIdleTimeoutSeconds: number | null;
  adapterRequestedCapabilities: AdapterCapabilities | null;
  adapterCreatePayloadJson: string | null;
};

export type AdapterFailureReleaseState = {
  status: "failed" | "stopping";
  terminalStatus: "failed" | null;
  message: "runtime workspace released" | "runtime workspace release pending";
};

const statusMap: Record<string, AdapterSessionStatus> = {
  pending: "provisioning",
  provisioning: "provisioning",
  creating: "provisioning",
  starting: "provisioning",
  ready: "ready",
  running: "ready",
  healthy: "ready",
  attached: "attached",
  detached: "detached",
  stopping: "stopping",
  deleting: "stopping",
  stopped: "stopped",
  deleted: "stopped",
  released: "stopped",
  expired: "expired",
  failed: "failed",
  error: "failed",
};

export function runtimeAdapterCollectionUrl(base: string): string {
  return joinAdapterUrl(base, "/v1/workspaces");
}

export function runtimeAdapterControlPlaneIdentity(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("?") || value.includes("#")) return null;
  const safe = safeDesktopUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  if (url.search || url.hash) return null;
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

export function runtimeAdapterControlPlaneForProfile(
  directValue: unknown,
  templateValue: unknown,
  profile: unknown,
): string | null {
  const hasDirect = typeof directValue === "string" && directValue.length > 0;
  const hasTemplate = typeof templateValue === "string" && templateValue.length > 0;
  if (hasDirect === hasTemplate) return null;
  if (hasDirect) return runtimeAdapterControlPlaneIdentity(directValue);
  if (
    typeof templateValue !== "string" ||
    typeof profile !== "string" ||
    !runtimeAdapterProfileRoutePattern.test(profile) ||
    templateValue.includes("?") ||
    templateValue.includes("#") ||
    templateValue.split(runtimeAdapterProfileRoutePlaceholder).length !== 2 ||
    !/(?:^|\/)\{profile\}(?:\/|$)/u.test(templateValue)
  ) {
    return null;
  }
  const routeSentinel = "crabfleet-profile-route";
  const sentinelControlPlane = runtimeAdapterControlPlaneIdentity(
    templateValue.replace(runtimeAdapterProfileRoutePlaceholder, routeSentinel),
  );
  if (
    !sentinelControlPlane ||
    !new URL(sentinelControlPlane).pathname.split("/").includes(routeSentinel)
  ) {
    return null;
  }
  return runtimeAdapterControlPlaneIdentity(
    templateValue.replace(runtimeAdapterProfileRoutePlaceholder, profile),
  );
}

export function runtimeAdapterTerminalOriginMatches(
  controlPlane: string,
  attachUrl: string,
): boolean {
  const terminalValue = safeWebSocketUrl(attachUrl);
  const controlPlaneValue = runtimeAdapterControlPlaneIdentity(controlPlane);
  if (!terminalValue || !controlPlaneValue) return false;
  const terminal = new URL(terminalValue);
  terminal.protocol = terminal.protocol === "wss:" ? "https:" : "http:";
  return terminal.origin === new URL(controlPlaneValue).origin;
}

export function runtimeAdapterWorkspaceUrl(base: string, adapterWorkspaceId: string): string {
  return joinAdapterUrl(base, `/v1/workspaces/${encodeURIComponent(adapterWorkspaceId)}`);
}

export function runtimeAdapterDesktopUrl(base: string, adapterWorkspaceId: string): string {
  return `${runtimeAdapterWorkspaceUrl(base, adapterWorkspaceId)}/connections/desktop`;
}

export function runtimeAdapterBrowserVncUrl(canonicalUrl: string, sessionId: string): string {
  return new URL(
    `/api/interactive-sessions/${encodeURIComponent(sessionId)}/vnc`,
    canonicalUrl,
  ).toString();
}

export function normalizeAdapterWorkspaceId(value: string): string | null {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return normalized || null;
}

export function normalizeAdapterNamespace(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 32) return null;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(normalized) ? normalized : null;
}

export function namespacedAdapterWorkspaceId(namespace: string, value: string): string | null {
  const normalizedNamespace = normalizeAdapterNamespace(namespace);
  const normalizedId = normalizeAdapterWorkspaceId(value);
  if (!normalizedNamespace || !normalizedId) return null;
  const id = `${normalizedNamespace}-${normalizedId}`;
  return id.length <= 63 ? id : null;
}

export function runtimeAdapterCreatePayload(
  input: AdapterCreateInput,
  persistedWorkspaceId?: string,
): Record<string, unknown> | null {
  const id = persistedWorkspaceId
    ? normalizeAdapterWorkspaceId(persistedWorkspaceId) === persistedWorkspaceId
      ? persistedWorkspaceId
      : null
    : namespacedAdapterWorkspaceId(input.namespace, input.id);
  if (!id) return null;
  return {
    id,
    parentSessionId: input.parentSessionId,
    rootSessionId: input.rootSessionId,
    repo: input.repo,
    branch: input.branch,
    runtime: input.runtime,
    profile: input.profile,
    command: input.command,
    prompt: input.prompt,
    purpose: input.purpose,
    summary: input.summary,
    owner: input.owner,
    createdBy: input.createdBy,
    ttlSeconds: input.ttlSeconds,
    idleTimeoutSeconds: input.idleTimeoutSeconds,
    capabilities: {
      desktop: input.desktop,
    },
  };
}

export function shouldReplayRuntimeAdapterCreate(
  status: AdapterSessionStatus,
  createPending: boolean,
): boolean {
  return createPending && (status === "provisioning" || status === "pending_adapter");
}

export function runtimeAdapterTerminalFailureStatus(
  adapter: string | null,
): "detached" | "expired" {
  return adapter === runtimeAdapterName ? "detached" : "expired";
}

export function legacyLeaseIdForAdapter(
  adapter: string | null,
  leaseId: string | null,
): string | null {
  return adapter === runtimeAdapterName ? null : leaseId;
}

export function resolveCreateAfterStopRace(
  createPending: boolean,
  requestedTerminalStatus: "failed" | null,
): {
  status: "stopping" | "stopped" | "failed";
  terminalStatus: "failed" | null;
} {
  return createPending
    ? { status: "stopping", terminalStatus: requestedTerminalStatus }
    : { status: requestedTerminalStatus ?? "stopped", terminalStatus: null };
}

export function runtimeAdapterReplayRequest(
  session: AdapterProvisionRecord,
): AdapterProvisionRequest {
  return {
    id: session.id,
    adapterWorkspaceId: session.adapter_workspace_id,
    adapterControlPlane: session.adapter_control_plane,
    parentSessionId: session.parent_session_id,
    rootSessionId: session.root_session_id ?? session.id,
    repo: session.repo,
    branch: session.branch,
    runtime: session.runtime,
    profile: session.profile,
    command: session.command,
    prompt: session.prompt,
    purpose: session.purpose,
    summary: session.summary,
    owner: session.owner,
    createdBy: session.created_by,
    adapterTtlSeconds: session.adapter_ttl_seconds,
    adapterIdleTimeoutSeconds: session.adapter_idle_timeout_seconds,
    adapterRequestedCapabilities: storedAdapterCapabilities(
      session.adapter_requested_capabilities_json,
    ),
    adapterCreatePayloadJson: session.adapter_create_payload_json,
  };
}

export function validatedRuntimeAdapterCreatePayloadJson(
  value: string,
  expected: {
    workspaceId: string;
    ttlSeconds: number;
    idleTimeoutSeconds: number;
    desktop: boolean;
  },
): string | null {
  if (!value || value.length > 100_000) return null;
  try {
    const payload = objectValue(JSON.parse(value));
    const capabilities = objectValue(payload.capabilities);
    return payload.id === expected.workspaceId &&
      payload.ttlSeconds === expected.ttlSeconds &&
      payload.idleTimeoutSeconds === expected.idleTimeoutSeconds &&
      capabilities.desktop === expected.desktop
      ? value
      : null;
  } catch {
    return null;
  }
}

export function adapterFailureReleaseState(
  release: "stopped" | "stopping",
): AdapterFailureReleaseState {
  return release === "stopped"
    ? {
        status: "failed",
        terminalStatus: null,
        message: "runtime workspace released",
      }
    : {
        status: "stopping",
        terminalStatus: "failed",
        message: "runtime workspace release pending",
      };
}

export function retainedRuntimeAdapterFailureMessage(
  failureReason: string | null,
  reconcileError: string | null,
  lastEvent: string | null,
): string {
  return (
    firstString(failureReason, reconcileError, lastEvent) ??
    "interactive workspace failed after release"
  );
}

export function definitiveRuntimeAdapterCreateFailure(status: number): boolean {
  return status >= 400 && status < 500 && ![408, 409, 423, 425, 429].includes(status);
}

export function runtimeAdapterWorkspaceIdConflict(status: number, value: unknown): boolean {
  if (status !== 409) return false;
  const body = objectValue(value);
  const error = objectValue(body.error);
  return error.code === "workspace_id_conflict";
}

export function effectiveAdapterCapabilities(
  result: Pick<
    AdapterWorkspaceResult,
    "capabilities" | "capabilitiesPresent" | "capabilitiesOverlay" | "terminalCapabilityInferred"
  >,
  defaults: AdapterCapabilities,
  initialCreate: boolean,
): AdapterCapabilities | null | undefined {
  if (!initialCreate && !result.capabilitiesPresent && !result.terminalCapabilityInferred) {
    return undefined;
  }
  const capabilities = result.capabilitiesPresent
    ? result.capabilities === null
      ? clearedAdapterCapabilities
      : result.capabilitiesOverlay
        ? { ...defaults, ...result.capabilitiesOverlay }
        : result.capabilities
    : initialCreate || result.terminalCapabilityInferred
      ? defaults
      : null;
  return capabilities && result.terminalCapabilityInferred
    ? { ...capabilities, terminal: true }
    : capabilities;
}

export function parseAdapterWorkspaceResult(
  value: unknown,
  fallback: {
    workspaceId?: string | null;
    providerResourceId?: string | null;
    profile?: string | null;
  } = {},
): AdapterWorkspaceResult | null {
  const body = objectValue(value);
  const workspace = objectValue(body.workspace ?? body.data);
  const status = adapterStatus(body.status ?? body.state ?? workspace.status ?? workspace.state);
  if (!status) return null;

  const connections = objectValue(body.connections ?? workspace.connections);
  const terminal = objectValue(connections.terminal ?? body.terminal ?? workspace.terminal);
  const terminalUrlField = firstPresentField([
    [terminal, "url"],
    [connections, "terminalUrl"],
    [connections, "terminal_url"],
    [body, "terminalUrl"],
    [body, "terminal_url"],
    [body, "attachUrl"],
    [body, "attach_url"],
    [workspace, "attachUrl"],
    [workspace, "attach_url"],
  ]);
  const terminalUrl = safeWebSocketUrl(terminalUrlField.value);
  const capabilityField = firstPresentField([
    [body, "capabilities"],
    [workspace, "capabilities"],
    [body, "features"],
    [workspace, "features"],
  ]);
  let capabilities = adapterCapabilities(capabilityField.value);
  const capabilitiesOverlay = adapterCapabilityOverlay(capabilityField.value);
  const terminalCapabilitySpecified =
    capabilityField.present &&
    (capabilitiesOverlay === null || Object.hasOwn(capabilitiesOverlay, "terminal"));
  const terminalCapabilityInferred = Boolean(terminalUrl && !terminalCapabilitySpecified);
  if (terminalCapabilityInferred && capabilities) {
    capabilities = { ...capabilities, terminal: true };
  }
  const workspaceIdentity = exactReportedAdapterWorkspaceId([
    [body, "workspaceId"],
    [body, "workspace_id"],
    [body, "id"],
    [workspace, "workspaceId"],
    [workspace, "workspace_id"],
    [workspace, "id"],
  ]);
  if (!workspaceIdentity) return null;
  const reportedWorkspaceId = workspaceIdentity.value;
  const fallbackWorkspaceId = exactAdapterWorkspaceId(fallback.workspaceId);
  if (fallback.workspaceId !== undefined && fallback.workspaceId !== null && !fallbackWorkspaceId) {
    return null;
  }
  const workspaceId = reportedWorkspaceId ?? fallbackWorkspaceId;
  const providerResourceId = firstString(
    body.providerResourceId,
    body.provider_resource_id,
    body.leaseId,
    body.lease_id,
    workspace.providerResourceId,
    workspace.provider_resource_id,
    workspace.leaseId,
    workspace.lease_id,
    fallback.providerResourceId,
  );
  const expiryField = firstPresentField([
    [body, "expiresAt"],
    [body, "expires_at"],
    [workspace, "expiresAt"],
    [workspace, "expires_at"],
  ]);
  const expiresAt = adapterTimestamp(expiryField.value);
  if (expiryField.present && expiryField.value !== null && expiresAt === null) return null;

  return {
    status,
    workspaceId,
    reportedWorkspaceId,
    providerResourceId,
    terminalUrl,
    terminalUrlPresent: terminalUrlField.present,
    capabilities,
    capabilitiesPresent: capabilityField.present,
    capabilitiesOverlay,
    terminalCapabilityInferred,
    expiresAt,
    expiresAtPresent: expiryField.present,
    profile: firstString(body.profile, workspace.profile, fallback.profile),
    message: redactedAdapterMessage(
      firstString(body.message, workspace.message),
      status,
      [reportedWorkspaceId, providerResourceId],
      adapterConnectionValues(body, workspace),
    ),
  };
}

export function redactedAdapterResponseMessage(
  value: unknown,
  fallback: string,
  identifiers: Array<string | null> = [],
): string {
  const body = objectValue(value);
  const workspace = objectValue(body.workspace ?? body.data);
  const error = objectValue(body.error);
  const errorWorkspace = objectValue(error.workspace ?? error.data);
  return redactedAdapterMessage(
    firstString(
      body.message,
      error.message,
      error.detail,
      error.reason,
      body.error,
      body.detail,
      body.reason,
      workspace.message,
      workspace.error,
      workspace.detail,
      workspace.reason,
    ) ?? fallback,
    "failed",
    [...identifiers, ...adapterProviderIdentifiers(body, workspace, error, errorWorkspace)],
    adapterConnectionValues(body, workspace),
  );
}

function adapterProviderIdentifiers(
  ...objects: Array<Record<string, unknown>>
): Array<string | null> {
  return objects.flatMap((object) => [
    firstRawString(object.providerResourceId),
    firstRawString(object.provider_resource_id),
    firstRawString(object.leaseId),
    firstRawString(object.lease_id),
  ]);
}

function storedAdapterCapabilities(value: string | null): AdapterCapabilities | null {
  if (!value) return null;
  try {
    return adapterCapabilities(JSON.parse(value));
  } catch {
    return null;
  }
}

export function adapterWorkspaceIdMatches(
  result: AdapterWorkspaceResult,
  expectedWorkspaceId: string,
): boolean {
  return result.reportedWorkspaceId === expectedWorkspaceId;
}

export function runtimeAdapterStopOutcome(
  responseStatus: number,
  result: AdapterWorkspaceResult | null,
  expectedWorkspaceId: string,
): "stopped" | "stopping" | "identity_mismatch" {
  if (responseStatus === 404 || responseStatus === 204) return "stopped";
  if (result && !adapterWorkspaceIdMatches(result, expectedWorkspaceId)) {
    return "identity_mismatch";
  }
  return result?.status === "stopped" || result?.status === "expired" ? "stopped" : "stopping";
}

export function parseAdapterDesktopConnection(value: unknown): AdapterDesktopConnection | null {
  const body = objectValue(value);
  const connection = objectValue(body.connection ?? body.desktop ?? body.data);
  const url = safeDesktopUrl(
    firstRawString(
      body.url,
      body.desktopUrl,
      body.desktop_url,
      body.vncUrl,
      body.vnc_url,
      connection.url,
      connection.vncUrl,
      connection.vnc_url,
    ),
  );
  if (!url) return null;
  const expiryField = firstPresentField([
    [body, "expiresAt"],
    [body, "expires_at"],
    [connection, "expiresAt"],
    [connection, "expires_at"],
  ]);
  const expiresAt = adapterTimestamp(expiryField.value);
  if (expiryField.present && expiryField.value !== null && expiresAt === null) return null;
  return {
    url,
    expiresAt,
    expiresAtPresent: expiryField.present && expiryField.value !== null,
  };
}

export function currentAdapterDesktopConnection(
  value: unknown,
  now = Date.now(),
  maxTtlMs = runtimeAdapterDesktopMaxTtlMs,
): AdapterDesktopConnection | null {
  const connection = parseAdapterDesktopConnection(value);
  if (
    !connection ||
    (connection.expiresAtPresent &&
      (connection.expiresAt === null ||
        connection.expiresAt <= now ||
        connection.expiresAt > now + maxTtlMs))
  ) {
    return null;
  }
  return connection;
}

export function safeDesktopUrl(value: unknown): string | null {
  return exactSecureHttpUrl(value);
}

export function safeWebSocketUrl(value: unknown): string | null {
  return exactSecureWebSocketUrl(value);
}

function adapterStatus(value: unknown): AdapterSessionStatus | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return statusMap[normalized] ?? null;
}

function adapterCapabilities(value: unknown): AdapterCapabilities | null {
  const defaults: AdapterCapabilities = {
    terminal: false,
    takeover: false,
    vnc: false,
    desktop: false,
    logs: true,
    artifacts: false,
  };
  if (Array.isArray(value)) {
    const features = new Set(value.map((item) => String(item).toLowerCase()));
    return {
      ...defaults,
      terminal: features.has("terminal") || features.has("pty") || features.has("ssh"),
      takeover: features.has("takeover"),
      vnc: features.has("vnc") || features.has("webvnc") || features.has("desktop"),
      desktop: features.has("desktop") || features.has("vnc") || features.has("webvnc"),
      artifacts: features.has("artifacts"),
    };
  }
  const overlay = adapterCapabilityOverlay(value);
  return overlay ? { ...defaults, ...overlay } : null;
}

function adapterCapabilityOverlay(value: unknown): Partial<AdapterCapabilities> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const capabilities = value as Record<string, unknown>;
  const overlay: Partial<AdapterCapabilities> = {};
  const terminal = firstPresentField([
    [capabilities, "terminal"],
    [capabilities, "pty"],
    [capabilities, "ssh"],
  ]);
  if (terminal.present) overlay.terminal = booleanValue(terminal.value);
  const takeover = firstPresentField([[capabilities, "takeover"]]);
  if (takeover.present) overlay.takeover = booleanValue(takeover.value);
  const desktop = firstPresentField([[capabilities, "desktop"]]);
  const vnc = firstPresentField([
    [capabilities, "vnc"],
    [capabilities, "webvnc"],
  ]);
  if (desktop.present || vnc.present) {
    const desktopAvailable = booleanValue(desktop.value) || booleanValue(vnc.value);
    overlay.desktop = desktopAvailable;
    overlay.vnc = desktopAvailable;
  }
  const logs = firstPresentField([[capabilities, "logs"]]);
  if (logs.present) overlay.logs = booleanValue(logs.value);
  const artifacts = firstPresentField([[capabilities, "artifacts"]]);
  if (artifacts.present) overlay.artifacts = booleanValue(artifacts.value);
  return overlay;
}

function adapterTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 1_000_000_000_000 ? Math.trunc(numeric * 1000) : Math.trunc(numeric);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function joinAdapterUrl(base: string, path: string): string {
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return new URL(path.replace(/^\/+/, ""), normalized).toString();
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstPresentField(fields: Array<[Record<string, unknown>, string]>): {
  present: boolean;
  value: unknown;
} {
  for (const [object, key] of fields) {
    if (Object.hasOwn(object, key)) return { present: true, value: object[key] };
  }
  return { present: false, value: undefined };
}

function exactReportedAdapterWorkspaceId(
  fields: Array<[Record<string, unknown>, string]>,
): { value: string | null } | null {
  let value: string | null = null;
  for (const [object, key] of fields) {
    if (!Object.hasOwn(object, key)) continue;
    const candidate = exactAdapterWorkspaceId(object[key]);
    if (!candidate || (value !== null && value !== candidate)) return null;
    value = candidate;
  }
  return { value };
}

function exactAdapterWorkspaceId(value: unknown): string | null {
  return typeof value === "string" && normalizeAdapterWorkspaceId(value) === value ? value : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstRawString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === "true";
}

export function redactedAdapterMessage(
  value: string | null,
  status: AdapterSessionStatus,
  identifiers: Array<string | null> = [],
  connectionValues: Array<string | null> = [],
): string {
  let message = value || `runtime adapter workspace ${status}`;
  const sensitiveName =
    "access[_-]?token|api[_-]?key|apikey|auth|authorization|client[_-]?secret|code|cookie|credential|id[_-]?token|key|password|passwd|refresh[_-]?token|secret|session[_-]?token|sig|signature|ticket|token|x-amz-signature";
  message = message
    .replace(/\b(?:https?|wss?):(?:\\+\/){2}[^\s<>{}"'`]+/giu, "[connection]")
    .replace(/\b(?:https?|wss?):\/\/[^\s<>{}"'`]+/giu, "[connection]")
    .replace(
      /\b(?:authorization|proxy-authorization|x-api-key|api-key)\s*:\s*[^\r\n]+/giu,
      "[credential]",
    )
    .replace(/\b(?:bearer|basic)\s+[^\s,;}\x5d]+/giu, "[credential]")
    .replace(/\b(?:cookie|set-cookie)\s*:\s*[^\r\n]+/giu, "[credential]")
    .replace(
      new RegExp(
        `(?:\\\\?["']?)(?:${sensitiveName})(?:\\\\?["']?)\\s*[:=]\\s*(?!\\[credential\\])(?:\\\\?["'](?:\\\\.|[^"'\\\\])*\\\\?["']|[^\\s,;}&}\\x5d]+)`,
        "giu",
      ),
      "[credential]",
    );
  const orderedConnections = [
    ...new Set(connectionValues.filter((connection): connection is string => Boolean(connection))),
  ].sort((left, right) => right.length - left.length);
  for (const connection of orderedConnections) {
    for (const representation of escapedConnectionRepresentations(connection)) {
      message = message.replaceAll(representation, "[connection]");
    }
  }
  const orderedIdentifiers = [
    ...new Set(identifiers.filter((identifier): identifier is string => Boolean(identifier))),
  ].sort((left, right) => right.length - left.length);
  for (const identifier of orderedIdentifiers) {
    message = message.replaceAll(identifier, "[workspace]");
  }
  let withoutControls = "";
  for (let index = 0; index < message.length; index += 1) {
    const code = message.charCodeAt(index);
    withoutControls += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : message[index];
  }
  return withoutControls.replace(/\s+/gu, " ").trim().slice(0, 500);
}

function adapterConnectionValues(
  body: Record<string, unknown>,
  workspace: Record<string, unknown>,
): Array<string | null> {
  const connections = objectValue(body.connections ?? workspace.connections);
  const terminal = objectValue(connections.terminal ?? body.terminal ?? workspace.terminal);
  const desktop = objectValue(connections.desktop ?? body.desktop ?? workspace.desktop);
  const values: Array<string | null> = [
    terminal.url,
    connections.terminalUrl,
    connections.terminal_url,
    body.terminalUrl,
    body.terminal_url,
    body.attachUrl,
    body.attach_url,
    workspace.attachUrl,
    workspace.attach_url,
    desktop.url,
    connections.desktopUrl,
    connections.desktop_url,
    body.desktopUrl,
    body.desktop_url,
    body.vncUrl,
    body.vnc_url,
    workspace.desktopUrl,
    workspace.desktop_url,
    workspace.vncUrl,
    workspace.vnc_url,
  ].map((value) => (typeof value === "string" && value ? value : null));
  const connectionField = /^(?:attach|desktop|terminal|vnc)?_?url$/iu;
  const visited = new WeakSet<object>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 5) return;
    if (visited.has(value)) return;
    visited.add(value);
    for (const [key, nested] of Object.entries(value)) {
      if (connectionField.test(key) && typeof nested === "string" && nested) {
        values.push(nested);
      } else if (nested && typeof nested === "object") {
        visit(nested, depth + 1);
      }
    }
  };
  visit(body, 0);
  return values;
}

function escapedConnectionRepresentations(connection: string): string[] {
  const representations = new Set<string>();
  for (const initial of [connection, connection.replaceAll("/", "\\/")]) {
    let escaped = initial;
    for (let depth = 0; depth < 3; depth += 1) {
      representations.add(escaped);
      escaped = JSON.stringify(escaped).slice(1, -1);
    }
  }
  return [...representations].sort((left, right) => right.length - left.length);
}
