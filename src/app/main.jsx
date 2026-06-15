import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AdminDrawer } from "./admin-drawer.jsx";
import { api } from "./api.js";
import { useAppData } from "./app-data.js";
import { useAppMutations } from "./app-mutations.js";
import { useAppNavigation } from "./app-navigation.js";
import { AppShell } from "./app-shell.jsx";
import { ActionDialog, useActionDialog } from "./dialogs.jsx";
import { LoginScreen } from "./login.jsx";
import { isLoginScreenHidden } from "./login-state.js";
import { parseSessionLink, restoreSessionReturnUrl } from "./routing.js";
import { isTerminalKeyTarget } from "./session-state.js";
import { SessionsDrawer } from "./session-workspace.jsx";
import { configureTerminalHub, disposeAllTerminals } from "./terminal.js";
import { linkedInteractiveSessionPlaceholder, sessionItems } from "./utils.js";
import { CardDrawer, InteractiveDrawer, RunDrawer } from "./work-drawers.jsx";

function App() {
  const initialSessionLink = useMemo(() => {
    restoreSessionReturnUrl();
    return parseSessionLink();
  }, []);
  const [filter, setFilter] = useState("all");
  const sessionItemByIdRef = useRef(new Map());
  const {
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
    setSessionLayout,
    draggedSessionId,
    openDrawer,
    closeDrawer,
    closeAllDrawers,
    closeTopDrawer,
    showSessionGrid,
    openSessionGrid,
    setSessionUrl,
  } = useAppNavigation({ initialSessionLink, sessionItemByIdRef });
  const [initialSessionOpened, setInitialSessionOpened] = useState(false);
  const { dialog, openActionDialog, closeActionDialog, confirmActionDialog } = useActionDialog();
  const [terminalStatus, setTerminalStatus] = useState({});
  const {
    state,
    setState,
    stateRef,
    signedIn,
    authMethods,
    loginMessage,
    setLoginMessage,
    refreshState,
    loadSharedSession,
    beginLogin,
    tokenLogin,
    devIdentityLogin,
    logout,
  } = useAppData({
    initialSessionLink,
    activeRunId,
    runDrawerOpen: Boolean(drawers.run),
    sharedSessionId,
    sharedToken,
    onSignedOut: closeAllDrawers,
    onSharedSessionLoaded: (session) => {
      setFocusedSessionId(session.id);
      openSessionGrid(session.id, { deepLink: true });
    },
    onSharedSessionRejected: () => {
      closeAllDrawers();
      setSharedSessionId(null);
      setSharedToken(null);
      setFocusedSessionId(null);
      setInitialSessionOpened(true);
      setSessionUrl(null);
    },
  });
  const mutations = useAppMutations({
    state,
    setState,
    stateRef,
    refreshState,
    setLoginMessage,
    openActionDialog,
    closeDrawer,
    openDrawer,
    setActiveRunId,
    focusedSessionIdRef,
    setFocusedSessionId,
    sharedToken,
    setSessionUrl,
    openSessionGrid,
  });
  const { findInteractiveSession, upsertInteractiveSession } = mutations;

  const allSessionItems = useMemo(() => sessionItems(state), [state]);
  const sessionItemById = useMemo(
    () => new Map(allSessionItems.map((item) => [item.id, item])),
    [allSessionItems],
  );
  sessionItemByIdRef.current = sessionItemById;

  useEffect(() => () => disposeAllTerminals(), []);

  useEffect(() => {
    document.documentElement.dataset.appRuntime = "preact";
    document.body.classList.toggle("locked", !signedIn && !(sharedSessionId && sharedToken));
  }, [signedIn, sharedSessionId, sharedToken]);

  useEffect(() => {
    configureTerminalHub({
      sharedSessionId,
      sharedToken,
      sessions: () => sessionItems(stateRef.current),
      onStatus: (id, label) =>
        setTerminalStatus((current) => {
          if (current[id] === label) return current;
          return { ...current, [id]: label };
        }),
    });
  }, [sharedSessionId, sharedToken, state]);

  useEffect(() => {
    if (!sharedSessionId) return;
    void openInitialSessionLink();
  }, [sharedSessionId, signedIn, state.interactiveSessions]);

  async function loadLinkedInteractiveSession(id) {
    const result = await api(`/api/interactive-sessions/${encodeURIComponent(id)}`);
    upsertInteractiveSession(result.session);
    setInitialSessionOpened(true);
    setFocusedSessionId(result.session.id);
    openSessionGrid(result.session.id, { deepLink: true });
  }

  async function openInitialSessionLink() {
    if (!sharedSessionId) return;
    const existing = findInteractiveSession(sharedSessionId);
    if (!existing || existing.routePlaceholder) {
      if (
        signedIn &&
        (!initialSessionOpened || focusedSessionId === sharedSessionId) &&
        existing?.status !== "unavailable"
      ) {
        try {
          await loadLinkedInteractiveSession(sharedSessionId);
        } catch (error) {
          if (error.status !== 403 && error.status !== 404) throw error;
          upsertInteractiveSession(
            linkedInteractiveSessionPlaceholder(sharedSessionId, {
              status: "unavailable",
              lastEvent:
                error.status === 404
                  ? "Codex session was not found."
                  : "You do not have access to this Codex session.",
              sharedReadOnly: Boolean(sharedToken),
            }),
          );
          setInitialSessionOpened(true);
          setFocusedSessionId(sharedSessionId);
          openSessionGrid(sharedSessionId);
        }
      } else if (
        !signedIn &&
        sharedToken &&
        existing?.status !== "unavailable" &&
        !document.body.classList.contains("locked")
      ) {
        await loadSharedSession();
      } else if (!initialSessionOpened) {
        if (!existing) {
          upsertInteractiveSession(
            linkedInteractiveSessionPlaceholder(sharedSessionId, {
              sharedReadOnly: Boolean(sharedToken),
            }),
          );
        }
        setInitialSessionOpened(true);
        setFocusedSessionId(sharedSessionId);
        openSessionGrid(sharedSessionId);
      }
      return;
    }
    if (initialSessionOpened && focusedSessionId !== sharedSessionId) return;
    setInitialSessionOpened(true);
    setFocusedSessionId(sharedSessionId);
    openSessionGrid(sharedSessionId);
  }

  const props = {
    state,
    appView,
    setAppView,
    signedIn,
    authMethods,
    loginMessage,
    filter,
    setFilter,
    ...mutations,
    drawers,
    activeRunId,
    focusedSessionId,
    sharedSessionId,
    sharedToken,
    setFocusedSessionId,
    showSessionGrid,
    theme,
    dialog,
    terminalStatus,
    sessionLayout,
    setSessionLayout,
    draggedSessionId,
    allSessionItems,
    sessionItemById,
    openDrawer,
    closeDrawer,
    closeAllDrawers,
    closeTopDrawer,
    openSessionGrid,
    beginLogin,
    tokenLogin,
    devIdentityLogin,
    logout,
    setTheme,
    closeActionDialog,
    confirmActionDialog,
  };

  return <CrabfleetApp {...props} />;
}

function CrabfleetApp(props) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "Escape" || event.isComposing || isTerminalKeyTarget(event)) return;
      if (props.closeTopDrawer()) event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [props.drawers]);

  return (
    <>
      <LoginScreen
        hidden={isLoginScreenHidden({ ...props, user: props.state.user })}
        authMethods={props.authMethods}
        deployment={props.state.deployment}
        message={props.loginMessage}
        onGithub={props.beginLogin}
        onToken={props.tokenLogin}
        onDevIdentity={props.devIdentityLogin}
      />
      <AppShell {...props} />
      <CardDrawer {...props} />
      <InteractiveDrawer {...props} />
      <RunDrawer {...props} />
      <SessionsDrawer {...props} />
      <AdminDrawer {...props} />
      <ActionDialog
        dialog={props.dialog}
        onCancel={props.closeActionDialog}
        onConfirm={props.confirmActionDialog}
      />
    </>
  );
}

render(
  <App />,
  document.getElementById("crabfleet-preact-root") ||
    document.getElementById("crabbox-preact-root"),
);
