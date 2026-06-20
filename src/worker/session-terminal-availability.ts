import type { InteractiveSession } from "./session-model.ts";

export function interactiveSessionPtyAvailable(
  session: InteractiveSession,
  canView: boolean,
  terminalRouteAvailable: boolean,
): boolean {
  return (
    canView &&
    session.capabilities.terminal &&
    ["ready", "attached", "detached"].includes(session.status) &&
    terminalRouteAvailable
  );
}
