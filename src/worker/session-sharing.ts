import type { InteractiveSession } from "./session-model.ts";
import { interactiveSessionPtyAvailable } from "./session-terminal-availability.ts";

export type SharedInteractiveSessionAccess = {
  canControl?: boolean;
  terminalRouteAvailable?: boolean;
};

export function activeDelegatedController(session: InteractiveSession, now: number): string | null {
  if (!session.controller) return null;
  if (typeof session.controlExpiresAt !== "number" || session.controlExpiresAt <= now) return null;
  return session.controller;
}

export function sharedInteractiveSession(
  session: InteractiveSession,
  now: number,
  access: SharedInteractiveSessionAccess = {},
): InteractiveSession {
  const activeController = activeDelegatedController(session, now);
  const canControl = access.canControl === true;
  const ptyAvailable = interactiveSessionPtyAvailable(
    session,
    canControl,
    access.terminalRouteAvailable === true,
  );
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
    ptyAvailable,
    controller: activeController,
    controlGrantedAt: activeController ? session.controlGrantedAt : null,
    controlExpiresAt: activeController ? session.controlExpiresAt : null,
    multiplayerMode: session.multiplayerMode,
    canControl,
    canManage: false,
    canRequestControl: false,
    sharedReadOnly: !canControl,
  };
}
