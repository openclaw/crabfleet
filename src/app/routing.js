export const loginReturnKey = "crabbox-login-return";

export function parseSessionLink(locationLike = location) {
  const match = locationLike.pathname.match(/^\/(?:app\/)?sessions(?:\/([^/]+))?\/?$/);
  return {
    route: Boolean(match),
    id: match?.[1] ? decodeURIComponent(match[1]) : null,
    token: new URLSearchParams(locationLike.search).get("token"),
  };
}

export function initialAppView(locationLike = location) {
  return locationLike.pathname === "/app/board" || locationLike.pathname === "/app/board/"
    ? "board"
    : "fleet";
}

export function isGithubLoginCallback(locationLike = location) {
  return new URLSearchParams(locationLike.search).get("login") === "github";
}

export function appViewUrl(href, value) {
  const url = new URL(href);
  url.pathname = value === "board" ? "/app/board" : "/app/fleet";
  url.search = "";
  return url;
}

export function withoutSharedToken(href) {
  const url = new URL(href);
  url.searchParams.delete("token");
  return url;
}

export function sessionRouteUrl(
  href,
  { id, grid = false, appView = "fleet", sharedSessionId = null, sharedToken = null },
) {
  const url = new URL(href);
  if (id) {
    url.pathname = `/sessions/${encodeURIComponent(id)}`;
    url.search = "";
    if (sharedToken && id === sharedSessionId) url.searchParams.set("token", sharedToken);
    return url;
  }
  url.pathname = grid ? "/sessions" : appView === "board" ? "/app/board" : "/app/fleet";
  url.search = "";
  return url;
}

export function restorableSessionReturnUrl(saved, locationLike = location) {
  if (!saved) return null;
  const url = new URL(saved, locationLike.origin);
  const isSessionUrl =
    url.pathname === "/sessions" ||
    url.pathname === "/sessions/" ||
    url.pathname.startsWith("/sessions/") ||
    url.pathname.startsWith("/app/sessions/");
  if (url.origin !== locationLike.origin || !isSessionUrl) return null;
  if (locationLike.pathname !== "/app" && locationLike.pathname !== "/app/") return null;
  return `${url.pathname}${url.search}`;
}

export function restoreSessionReturnUrl({
  storage = sessionStorage,
  historyApi = history,
  locationLike = location,
} = {}) {
  try {
    if (!historyApi.replaceState) return;
    const restored = restorableSessionReturnUrl(storage.getItem(loginReturnKey), locationLike);
    if (!restored) return;
    storage.removeItem(loginReturnKey);
    historyApi.replaceState(null, "", restored);
  } catch {}
}
