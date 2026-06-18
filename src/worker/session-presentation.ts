import { runtimeAdapterName, workerOwnedLeaseId } from "../runtime-adapter.ts";
import {
  resolveRuntimeProfileCodexSsh,
  runtimeProfileByID,
  type RuntimeProfileDescriptor,
} from "../runtime-profiles.ts";
import type { User } from "./models.ts";
import {
  canChangeInteractiveSessionMultiplayer,
  canControlInteractiveSession,
  canManageInteractiveSession,
} from "./session-access.ts";
import { interactiveSessionAdapterControlPlane, type InteractiveSession } from "./session-model.ts";
import { activeDelegatedController } from "./session-sharing.ts";
import { interactiveSessionPtyAvailable } from "./session-terminal-availability.ts";

export type InteractiveSessionPresentationContext = {
  now: number;
  delegatedControlAvailable: boolean;
  terminalRouteAvailable: boolean;
  runtimeProfiles: RuntimeProfileDescriptor[];
  configuredRuntimeAdapterControlPlane: (profile: string) => string | null;
  browserVncUrl: (sessionId: string) => string;
};

export function presentInteractiveSession(
  session: InteractiveSession,
  user: User,
  context: InteractiveSessionPresentationContext,
): InteractiveSession {
  const canManage = canManageInteractiveSession(user, session);
  const canChangeMultiplayer = canChangeInteractiveSessionMultiplayer(user, session);
  const canControl = canControlInteractiveSession(
    user,
    session,
    context.now,
    context.delegatedControlAvailable,
  );
  const activeController = activeDelegatedController(session, context.now);
  const ready = ["ready", "attached", "detached"].includes(session.status);
  const versionedDesktopAvailable =
    ready &&
    session.adapter === runtimeAdapterName &&
    (session.capabilities.vnc || session.capabilities.desktop);
  const ptyAvailable = interactiveSessionPtyAvailable(
    session,
    canControl,
    context.terminalRouteAvailable,
  );
  const codexSshReady =
    session.adapter === runtimeAdapterName &&
    session.capabilities.terminal &&
    ready &&
    Boolean(session[interactiveSessionAdapterControlPlane]) &&
    context.configuredRuntimeAdapterControlPlane(session.profile) ===
      session[interactiveSessionAdapterControlPlane];
  const runtimeProfile = runtimeProfileByID(context.runtimeProfiles, session.profile);
  const codexSsh =
    canManage && codexSshReady
      ? resolveRuntimeProfileCodexSsh(runtimeProfile, {
          providerResourceId: session.providerResourceId,
          workspaceId: session.adapterWorkspaceId,
          sessionId: session.id,
          profile: session.profile,
        })
      : null;

  return {
    ...session,
    adapter: canControl ? session.adapter : null,
    profile: canControl ? session.profile : "",
    adapterWorkspaceId: canControl ? session.adapterWorkspaceId : null,
    providerResourceId: canControl ? session.providerResourceId : null,
    lastReconciledAt: canControl ? session.lastReconciledAt : null,
    reconcileError: canControl ? session.reconcileError : null,
    leaseId: canControl ? workerOwnedLeaseId(session.adapter, session.leaseId) : null,
    attachUrl: ptyAvailable ? "/api/terminal/ws" : null,
    ptyAvailable,
    codexSsh,
    vncUrl: canControl && versionedDesktopAvailable ? context.browserVncUrl(session.id) : null,
    controller: activeController,
    controlGrantedAt: activeController ? session.controlGrantedAt : null,
    controlExpiresAt: activeController ? session.controlExpiresAt : null,
    canManage,
    canChangeMultiplayer,
    canControl,
    canRequestControl: context.delegatedControlAvailable && !canControl,
  };
}
