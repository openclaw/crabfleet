import { isFleetSessionAttachable } from "./utils.js";

export function appShellMetrics(state) {
  return {
    active: state.cards.filter((card) => card.lane === "Running").length,
    queue: state.cards.filter((card) => card.lane === "Todo").length,
    review: state.cards.filter((card) => card.lane === "Human Review").length,
    cli:
      state.fleet?.totals?.attachable ??
      (state.interactiveSessions || []).filter(isFleetSessionAttachable).length,
  };
}

export function appUserPresentation({ signedIn, user }) {
  const trustedProxyUser = Boolean(signedIn && user?.subject?.startsWith("proxy:"));
  const userLabel =
    !signedIn && user?.subject === "shared"
      ? "Sign in for control"
      : user
        ? `${user.login || user.email || user.subject} / ${user.role}`
        : "Signed out";
  return { trustedProxyUser, userLabel };
}
