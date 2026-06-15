import { isTerminalKeyTarget } from "./session-state.js";

export function handleAppEscape(event, options) {
  if (event.key !== "Escape" || event.isComposing || isTerminalKeyTarget(event)) return false;

  if (options.dialog) {
    event.preventDefault();
    options.closeActionDialog();
    return true;
  }

  if (!options.closeTopDrawer()) return false;
  event.preventDefault();
  return true;
}
