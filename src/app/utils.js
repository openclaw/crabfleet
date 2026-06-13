import {
  githubActionsCapabilities,
  githubActionsRuntime,
  githubActionsRuntimeLabel,
} from "../github-actions-runtime.ts";

export const lanes = ["Todo", "Running", "Human Review", "Done"];
export const preferredRepo = "openclaw/crabfleet";

const activeInteractiveStatuses = new Set([
  "provisioning",
  "pending_adapter",
  "ready",
  "attached",
  "detached",
]);
const deadInteractiveStatuses = new Set(["stopped", "expired", "failed", "unavailable"]);
const provisioningInteractiveStatuses = new Set(["provisioning", "pending_adapter"]);
const terminalReadyInteractiveStatuses = new Set(["ready", "attached", "detached"]);

export function roleRank(role) {
  return { viewer: 1, maintainer: 2, owner: 3 }[role] || 0;
}

export function canMaintain(user) {
  return roleRank(user?.role) >= roleRank("maintainer");
}

export function canOwn(user) {
  return roleRank(user?.role) >= roleRank("owner");
}

export function preferredRepos(repos = [], preferred = preferredRepo) {
  return [...repos].sort((left, right) => {
    if (left === preferred) return -1;
    if (right === preferred) return 1;
    return left.localeCompare(right);
  });
}

export function issueNumber(value) {
  const match = String(value || "")
    .trim()
    .match(/^#?(\d+)$/);
  return match ? match[1] : "";
}

export function elapsed(value) {
  if (!value) return "0m";
  return `${Math.max(1, Math.floor((Date.now() - value) / 60000))}m`;
}

export function statusLabel(status) {
  return { added: "A", deleted: "D", modified: "M", renamed: "R" }[status] || "M";
}

export function titleFromPrompt(prompt) {
  const line = String(prompt || "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  return line?.replace(/^#+\s*/, "").slice(0, 140) || "Untitled card";
}

export function sessionTitle(session) {
  return session.title || `${session.repo} · ${session.branch}`;
}

export function runRuntime(session) {
  return session.run?.runtime || session.runtime;
}

export function runCapabilities(session) {
  if (session.kind !== "interactive" && session.run?.capabilities) {
    return session.run.capabilities;
  }
  if (session.kind === "interactive" || session.capabilities) {
    if (session.runtime === githubActionsRuntime) return { ...githubActionsCapabilities };
    const crabbox = session.runtime === "crabbox";
    const defaults = {
      terminal: true,
      takeover: false,
      vnc: crabbox,
      desktop: crabbox,
      logs: true,
      artifacts: false,
    };
    return { ...defaults, ...session.capabilities };
  }
  const crabbox = runRuntime(session) === "crabbox";
  return {
    terminal: true,
    takeover: crabbox,
    vnc: crabbox,
    desktop: crabbox,
    logs: true,
    artifacts: true,
  };
}

export function hasRunCapability(session, name) {
  return name === "takeover" && !isActiveRun(session)
    ? false
    : runCapabilities(session)[name] === true;
}

export function isActiveRun(session) {
  if (session.routePlaceholder) return true;
  if (session.kind === "interactive") {
    return activeInteractiveStatuses.has(session.status);
  }
  return ["queued", "leasing", "running"].includes(session.run?.status);
}

export function isProvisioningInteractiveSession(session) {
  return (
    session?.kind === "interactive" &&
    ((session.routePlaceholder && session.status === "loading") ||
      provisioningInteractiveStatuses.has(session.status))
  );
}

export function isDeadInteractiveSession(session) {
  return (
    session &&
    (session.kind === undefined || session.kind === "interactive") &&
    deadInteractiveStatuses.has(session.status)
  );
}

export function isTerminalReadyInteractiveSession(session) {
  const lifecycleReady =
    session &&
    (session.kind === undefined || session.kind === "interactive") &&
    terminalReadyInteractiveStatuses.has(session.status) &&
    (session.capabilities?.terminal ?? runCapabilities(session).terminal);
  if (!lifecycleReady) return false;
  if (session.sharedReadOnly === true) return true;
  if (session.canControl === true) return session.ptyAvailable === true;
  return true;
}

export function isFleetSessionAttachable(session) {
  if (!runCapabilities(session).terminal) return false;
  if (typeof session?.fleet?.attachable === "boolean") return session.fleet.attachable;
  return isTerminalReadyInteractiveSession(session) && Boolean(session.attachUrl);
}

export function humanStatus(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function interactiveSessionStatus(session) {
  if (session.routePlaceholder && session.status === "loading") {
    return { label: "Loading", tone: "provisioning" };
  }
  if (session.routePlaceholder && session.status === "unavailable") {
    return { label: "Unavailable", tone: "failed" };
  }
  if (session.workState === "completed") return { label: "Completed", tone: "stopped" };
  if (session.workState === "blocked") return { label: "Blocked", tone: "failed" };
  if (session.workState === "canceled") return { label: "Canceled", tone: "stopped" };
  if (session.workState === "failed") return { label: "Failed", tone: "failed" };
  if (session.workState === "registered") {
    return { label: "Registered", tone: "provisioning" };
  }
  if (session.workState === "running" && session.workPhase) {
    return { label: humanStatus(session.workPhase), tone: "live" };
  }
  if (session.status === "failed") return { label: "Failed", tone: "failed" };
  if (session.status === "stopping") return { label: "Stopping", tone: "provisioning" };
  if (session.status === "stopped" || session.status === "expired") {
    return { label: "Stopped", tone: "stopped" };
  }
  if (provisioningInteractiveStatuses.has(session.status)) {
    return { label: "Provisioning", tone: "provisioning" };
  }
  if (session.shareMode === "link_read" || session.sharedReadOnly) {
    return { label: "Shared", tone: "shared" };
  }
  if (session.multiplayerMode) return { label: "Multiplayer", tone: "shared" };
  if (terminalReadyInteractiveStatuses.has(session.status)) {
    return { label: "Live", tone: "live" };
  }
  return { label: humanStatus(session.status), tone: "" };
}

export function sessionLogsUrl(id) {
  return `/api/interactive-sessions/${encodeURIComponent(id)}/logs`;
}

export function runtimeCapabilityLabel(session) {
  if (runRuntime(session) === githubActionsRuntime) return "GitHub Actions terminal";
  const capabilities = runCapabilities(session);
  if (capabilities.vnc) return "VNC eligible";
  if (capabilities.terminal) return "terminal";
  return runRuntime(session);
}

export function runtimeLabel(runtime) {
  return (
    githubActionsRuntimeLabel(runtime) || (runtime === "crabbox" ? "Crabbox" : "Cloudflare Sandbox")
  );
}

export function sessionItems(state) {
  const cardItems = state.cards.map((card) => ({ ...card, kind: "card" }));
  const interactiveItems = (state.interactiveSessions || []).map((session) => ({
    ...session,
    kind: "interactive",
    title: sessionTitle(session),
    lane: session.status,
    policy: "interactive",
  }));
  return [...interactiveItems, ...cardItems].sort((left, right) => {
    const laneRank = { Running: 0, "Human Review": 1, Todo: 2, Done: 3 };
    const leftLane = left.kind === "interactive" ? 0 : (laneRank[left.lane] ?? 4);
    const rightLane = right.kind === "interactive" ? 0 : (laneRank[right.lane] ?? 4);
    if (leftLane !== rightLane) return leftLane - rightLane;
    return sessionSortTime(right) - sessionSortTime(left);
  });
}

function sessionSortTime(session) {
  if (session.kind === "interactive") return Number(session.updatedAt || session.createdAt || 0);
  return Number(
    session.run?.lastHeartbeatAt ||
      session.updatedAt ||
      session.startedAt ||
      session.createdAt ||
      0,
  );
}

export function terminalText(session) {
  if (session.kind === "interactive") {
    if (isProvisioningInteractiveSession(session)) {
      const detail =
        session.status === "pending_adapter"
          ? "Runtime adapter pending."
          : session.routePlaceholder
            ? "Loading session..."
            : "Provisioning sandbox...";
      return [`Preparing Codex`, session.repo || "Codex session", detail].join("\r\n") + "\r\n";
    }
    if (session.routePlaceholder) {
      const logs =
        Array.isArray(session.logs) && session.logs.length
          ? session.logs
          : ["Loading Codex session..."];
      return [`$ codex attach ${session.id}`, "", ...logs].join("\r\n") + "\r\n";
    }
    const header = [
      `$ ${session.command || "codex"}`,
      `repo ${session.repo}`,
      `branch ${session.branch}`,
      `runtime ${session.runtime}`,
      `status ${session.status}`,
    ];
    if (session.workKey) header.push(`work ${session.workKey}`);
    if (session.workKind) header.push(`kind ${session.workKind}`);
    if (session.workState) header.push(`work state ${session.workState}`);
    if (session.workPhase) header.push(`phase ${session.workPhase}`);
    if (session.sourceUrl) header.push(`source ${session.sourceUrl}`);
    if (session.githubRunUrl) header.push(`run ${session.githubRunUrl}`);
    if (session.codexThreadId) header.push(`codex thread ${session.codexThreadId}`);
    if (session.codexTurnId) header.push(`codex turn ${session.codexTurnId}`);
    if (session.completionReason) header.push(`completion ${session.completionReason}`);
    if (session.attachUrl) header.push(`attach ${session.attachUrl}`);
    if (session.vncUrl) header.push(`vnc ${session.vncUrl}`);
    if (session.status === "pending_adapter") header.push("runtime adapter not configured yet");
    if (session.sharedReadOnly) header.push("read-only shared view");
    if (session.shareMode === "link_read" && !session.sharedReadOnly) {
      header.push(`share read-only link ${session.shareTokenPreview || "enabled"}`);
    }
    if (session.multiplayerMode) header.push("multiplayer mode");
    if (session.controlRequestedBy)
      header.push(`control requested by ${session.controlRequestedBy}`);
    if (session.controller) header.push(`controller ${session.controller}`);
    if (session.prompt) header.push("", session.prompt);
    const logs =
      Array.isArray(session.logs) && session.logs.length
        ? session.logs
        : ["Waiting for interactive workspace..."];
    return [...header, "", ...logs].join("\r\n") + "\r\n";
  }
  if (session.run) {
    const header = [
      `$ codex ${session.id}`,
      `repo ${session.repo}`,
      `runtime ${runRuntime(session)}`,
      `policy ${session.policy}`,
      `status ${session.run.status}`,
    ];
    const logs = Array.isArray(session.logs) && session.logs.length ? session.logs : [];
    return [...header, "", ...logs].join("\r\n") + "\r\n";
  }
  const logs =
    Array.isArray(session.logs) && session.logs.length ? session.logs : ["Codex session ready."];
  return logs.join("\r\n") + "\r\n";
}

export function clipboardName(mediaType) {
  return `clipboard-${Date.now()}${clipboardExtension(mediaType)}`;
}

export function clipboardExtension(mediaType) {
  return (
    {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "text/plain": ".txt",
      "text/markdown": ".md",
      "application/json": ".json",
      "application/pdf": ".pdf",
    }[
      String(mediaType || "")
        .toLowerCase()
        .split(";")[0]
    ] || ".bin"
  );
}

export function optimisticInteractiveSession(data, owner) {
  const now = Date.now();
  const repo = String(data.get("repo") || preferredRepo);
  const branch = String(data.get("branch") || "main");
  const runtime = String(data.get("runtime") || "container");
  const profile = String(data.get("profile") || "default");
  const pendingRuntimeLabel = runtimeLabel(runtime);
  return {
    id: `LOCAL-${now}`,
    repo,
    branch,
    runtime,
    profile,
    capabilities: {
      terminal: true,
      takeover: false,
      vnc: runtime === "crabbox",
      desktop: runtime === "crabbox",
      logs: true,
      artifacts: false,
    },
    command: interactiveCommand(data.get("command")),
    prompt: String(data.get("prompt") || ""),
    owner: owner || "local",
    status: "provisioning",
    leaseId: null,
    attachUrl: null,
    vncUrl: null,
    lastEvent: `Requesting ${pendingRuntimeLabel}...`,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    stoppedAt: null,
    shareMode: "private",
    shareTokenPreview: null,
    controlRequestedBy: null,
    controlRequestedAt: null,
    controller: null,
    controlGrantedAt: null,
    controlExpiresAt: null,
    multiplayerMode: false,
    canControl: true,
    canManage: true,
    canRequestControl: false,
    logs: [`Requesting ${pendingRuntimeLabel}...`, "Waiting for session id..."],
    title: `${repo} · ${branch}`,
  };
}

export function interactiveCommand(value) {
  return String(value || "codex --yolo")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/--yolosandbox\b/g, "--yolo");
}

export function linkedInteractiveSessionPlaceholder(id, options = {}) {
  const now = Date.now();
  const status = options.status || "loading";
  const lastEvent =
    options.lastEvent ||
    (status === "unavailable" ? "Session could not be loaded." : "Loading Codex session...");
  return {
    id,
    repo: "Codex session",
    branch: "",
    runtime: "crabbox",
    profile: "default",
    capabilities: {
      terminal: true,
      takeover: false,
      vnc: true,
      desktop: true,
      logs: true,
      artifacts: false,
    },
    command: "codex",
    prompt: "",
    owner: "unknown",
    status,
    leaseId: null,
    attachUrl: null,
    vncUrl: null,
    lastEvent,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    stoppedAt: null,
    shareMode: options.sharedReadOnly ? "link_read" : "private",
    shareTokenPreview: null,
    controlRequestedBy: null,
    controlRequestedAt: null,
    controller: null,
    controlGrantedAt: null,
    controlExpiresAt: null,
    multiplayerMode: false,
    canControl: false,
    canManage: false,
    canRequestControl: false,
    sharedReadOnly: Boolean(options.sharedReadOnly),
    routePlaceholder: true,
    logs: [lastEvent],
    title: `Codex session ${id}`,
  };
}
