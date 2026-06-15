import type { InteractiveSession } from "./session-model.ts";

export function interactiveSessionPtyAvailable(
  session: InteractiveSession,
  canControl: boolean,
  terminalRouteAvailable: boolean,
): boolean {
  return (
    canControl &&
    session.capabilities.terminal &&
    ["ready", "attached", "detached"].includes(session.status) &&
    terminalRouteAvailable
  );
}
