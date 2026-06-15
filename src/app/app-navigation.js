import { useEffect, useRef, useState } from "preact/hooks";
import { appViewUrl, initialAppView, sessionRouteUrl } from "./routing.js";
import { loadSessionLayout, saveSessionLayout } from "./session-layout.js";
import { disposeAllTerminals, warmGhosttyModule } from "./terminal.js";

const drawerOrder = ["card", "interactive", "run", "sessions", "admin"];

export function normalizedAppView(value) {
  return value === "board" ? "board" : "fleet";
}

export function topOpenDrawer(drawers) {
  return drawerOrder.findLast((key) => drawers[key]) || null;
}

export function sessionOpenTarget(id, currentId, sessionItemById, options = {}) {
  const targetId = id === undefined ? currentId : id;
  const deepLink =
    options.deepLink ?? Boolean(targetId && sessionItemById.get(targetId)?.kind === "interactive");
  const urlSessionId =
    targetId && deepLink && !String(targetId).startsWith("LOCAL-") ? targetId : null;
  return {
    targetId,
    clearFocus: id === null,
    urlSessionId,
    grid: !urlSessionId,
  };
}

export function useAppNavigation({ initialSessionLink, sessionItemByIdRef }) {
  const [appView, setAppViewState] = useState(initialAppView);
  const [drawers, setDrawers] = useState(initialSessionLink.route ? { sessions: true } : {});
  const [activeRunId, setActiveRunId] = useState(null);
  const [focusedSessionId, setFocusedSessionId] = useState(initialSessionLink.id);
  const [sharedSessionId, setSharedSessionId] = useState(initialSessionLink.id);
  const [sharedToken, setSharedToken] = useState(initialSessionLink.token);
  const [theme, setThemeState] = useState(
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  const [sessionLayout, setSessionLayout] = useState(loadSessionLayout);
  const focusedSessionIdRef = useRef(focusedSessionId);
  const draggedSessionId = useRef(null);

  focusedSessionIdRef.current = focusedSessionId;

  useEffect(() => {
    const onPopState = () => setAppViewState(initialAppView());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("crabbox-theme", theme);
    } catch {}
  }, [theme]);

  function setSessionUrl(id, options = {}) {
    if (!history.replaceState) return;
    history.replaceState(
      null,
      "",
      sessionRouteUrl(location.href, {
        id,
        grid: options.grid,
        appView,
        sharedSessionId,
        sharedToken,
      }),
    );
  }

  function openDrawer(id) {
    setDrawers((current) => ({ ...current, [id]: true }));
  }

  function closeDrawer(id) {
    setDrawers((current) => ({ ...current, [id]: false }));
    if (id === "run") setActiveRunId(null);
    if (id === "sessions") {
      setFocusedSessionId(null);
      if (!sharedToken) setSessionUrl(null);
      disposeAllTerminals();
    }
  }

  function closeAllDrawers() {
    setDrawers({});
    setActiveRunId(null);
    setFocusedSessionId(null);
    if (!sharedToken) setSessionUrl(null);
    disposeAllTerminals();
  }

  function setAppView(value) {
    const next = normalizedAppView(value);
    setAppViewState(next);
    closeAllDrawers();
    if (!history.pushState) return;
    history.pushState(null, "", appViewUrl(location.href, next));
  }

  function closeTopDrawer() {
    const id = topOpenDrawer(drawers);
    if (!id) return false;
    closeDrawer(id);
    return true;
  }

  function showSessionGrid() {
    setFocusedSessionId(null);
    if (!sharedToken) setSessionUrl(null, { grid: true });
    setDrawers((current) => ({ ...current, sessions: true }));
  }

  function openSessionGrid(id, options = {}) {
    const target = sessionOpenTarget(
      id,
      focusedSessionIdRef.current,
      sessionItemByIdRef.current,
      options,
    );
    if (target.targetId) setFocusedSessionId(target.targetId);
    else if (target.clearFocus) setFocusedSessionId(null);
    if (target.urlSessionId) setSessionUrl(target.urlSessionId);
    else if (!sharedToken) setSessionUrl(null, { grid: target.grid });
    warmGhosttyModule();
    setDrawers((current) => ({ ...current, sessions: true }));
  }

  function setTheme(value) {
    setThemeState(value === "light" ? "light" : "dark");
  }

  function updateSessionLayout(updater) {
    setSessionLayout((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      saveSessionLayout(next);
      return next;
    });
  }

  return {
    appView,
    setAppView,
    drawers,
    activeRunId,
    setActiveRunId,
    focusedSessionId,
    focusedSessionIdRef,
    setFocusedSessionId,
    sharedSessionId,
    setSharedSessionId,
    sharedToken,
    setSharedToken,
    theme,
    setTheme,
    sessionLayout,
    setSessionLayout: updateSessionLayout,
    draggedSessionId,
    openDrawer,
    closeDrawer,
    closeAllDrawers,
    closeTopDrawer,
    showSessionGrid,
    openSessionGrid,
    setSessionUrl,
  };
}
