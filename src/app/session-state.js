import {
  canMaintain,
  elapsed,
  humanStatus,
  interactiveSessionStatus,
  isActiveRun,
  isDeadInteractiveSession,
  runtimeCapabilityLabel,
} from "./utils.js";

export function terminalMountKey(session) {
  if (session.kind !== "interactive") return session.id;
  return [session.id, session.command, session.leaseId || ""].join(":");
}

export function isLocalInteractiveSession(session) {
  return session?.kind === "interactive" && String(session.id).startsWith("LOCAL-");
}

export function sessionTerminalStatusLabel(session, terminalStatus) {
  if (session.kind === "interactive" && isDeadInteractiveSession(session)) return "Log replay";
  return terminalStatus[session.id] || runtimeCapabilityLabel(session);
}

export function canCleanInteractiveSession(session, user) {
  return isDeadInteractiveSession(session) && (session.canManage || canMaintain(user));
}

export function isSessionGridItem(session) {
  if (session?.kind === "interactive") return true;
  return session?.kind === "card" && isActiveRun(session);
}

export function sessionStatus(session) {
  if (session.kind === "interactive") {
    return interactiveSessionStatus(session);
  }
  if (session.run?.status === "failed" || session.lane === "Human Review") {
    return { label: humanStatus(session.run?.status || session.lane), tone: "failed" };
  }
  if (session.lane === "Running") return { label: "Live", tone: "live" };
  if (session.lane === "Done") return { label: "Done", tone: "stopped" };
  return { label: session.lane || humanStatus(session.run?.status), tone: "" };
}

export function sessionFooterSummary(session) {
  if (session.kind === "interactive") {
    const parts = [session.id];
    const seen = session.lastHeartbeatAt || session.lastSeenAt || session.updatedAt;
    if (seen) parts.push(`seen ${elapsed(seen)}`);
    if (session.workKind) parts.push(humanStatus(session.workKind));
    if (session.workState) parts.push(humanStatus(session.workState));
    if (session.workPhase) parts.push(humanStatus(session.workPhase));
    if (session.status) parts.push(humanStatus(session.status));
    if (session.shareMode === "link_read" || session.sharedReadOnly) parts.push("shared");
    if (session.multiplayerMode) parts.push("multiplayer");
    if (session.controller) parts.push(`control ${session.controller}`);
    if (session.controlRequestedBy) parts.push(`request ${session.controlRequestedBy}`);
    return parts.join(" · ");
  }
  const parts = [session.id];
  if (session.run?.lastHeartbeatAt || session.startedAt) {
    parts.push(`seen ${elapsed(session.run?.lastHeartbeatAt || session.startedAt)}`);
  }
  if (session.run?.status) parts.push(humanStatus(session.run.status));
  if (session.run?.runtime || session.runtime) parts.push(session.run?.runtime || session.runtime);
  return parts.join(" · ");
}

export function terminalProvisioningDetail(session) {
  if (session.status === "pending_adapter") return "Runtime adapter pending";
  if (isLocalInteractiveSession(session)) return session.lastEvent || "Requesting workspace";
  if (session.routePlaceholder) return "Opening shared session";
  return "Provisioning sandbox and terminal";
}

export function isTerminalKeyTarget(event, activeElement = globalThis.document?.activeElement) {
  return Boolean(
    event.target?.closest?.(".ghostty-terminal") || activeElement?.closest?.(".ghostty-terminal"),
  );
}
