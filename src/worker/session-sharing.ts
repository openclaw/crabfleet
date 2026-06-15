import type { InteractiveSession } from "./session-model.ts";

export function activeDelegatedController(session: InteractiveSession, now: number): string | null {
  if (!session.controller) return null;
  if (typeof session.controlExpiresAt !== "number" || session.controlExpiresAt <= now) return null;
  return session.controller;
}

export function sharedInteractiveSession(
  session: InteractiveSession,
  now: number,
): InteractiveSession {
  const activeController = activeDelegatedController(session, now);
  return {
    ...session,
    adapter: null,
    profile: "",
    adapterWorkspaceId: null,
    providerResourceId: null,
    lastReconciledAt: null,
    reconcileError: null,
    leaseId: null,
    attachUrl: null,
    vncUrl: null,
    ptyAvailable: false,
    controller: activeController,
    controlGrantedAt: activeController ? session.controlGrantedAt : null,
    controlExpiresAt: activeController ? session.controlExpiresAt : null,
    multiplayerMode: session.multiplayerMode,
    canControl: false,
    canManage: false,
    canRequestControl: false,
    sharedReadOnly: true,
  };
}
