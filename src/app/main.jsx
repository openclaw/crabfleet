import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AdminDrawer } from "./admin-drawer.jsx";
import { useAppData } from "./app-data.js";
import { useAppMutations } from "./app-mutations.js";
import { useAppNavigation } from "./app-navigation.js";
import { AppShell } from "./app-shell.jsx";
import { ActionDialog, useActionDialog } from "./dialogs.jsx";
import { handleAppEscape } from "./keyboard-shortcuts.js";
import { useLinkedSession } from "./linked-session.js";
import { LoginScreen } from "./login.jsx";
import { isLoginScreenHidden } from "./login-state.js";
import { parseSessionLink, restoreSessionReturnUrl, withoutSharedToken } from "./routing.js";
import { SessionsDrawer } from "./session-workspace.jsx";
import { useTerminalHubState } from "./terminal-state.js";
import { sessionItems } from "./utils.js";
import { CardDrawer, InteractiveDrawer, RunDrawer } from "./work-drawers.jsx";
import { DesktopViewer, desktopViewerHostID } from "./desktop-viewer.jsx";

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
  const linkedSessionOpenedRef = useRef(false);
  const { dialog, openActionDialog, closeActionDialog, confirmActionDialog } = useActionDialog();
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
      linkedSessionOpenedRef.current = true;
      setSessionUrl(null);
    },
    onSharedSessionInvalidated: () => {
      setSharedToken(null);
      if (history.replaceState) {
        history.replaceState(null, "", withoutSharedToken(location.href));
      }
    },
  });
  const terminalStatus = useTerminalHubState({ sharedSessionId, sharedToken, stateRef });
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
  useLinkedSession({
    sharedSessionId,
    sharedToken,
    signedIn,
    focusedSessionId,
    interactiveSessions: state.interactiveSessions,
    openedRef: linkedSessionOpenedRef,
    findInteractiveSession,
    upsertInteractiveSession,
    loadSharedSession,
    setFocusedSessionId,
    openSessionGrid,
  });

  const allSessionItems = useMemo(() => sessionItems(state), [state]);
  const sessionItemById = useMemo(
    () => new Map(allSessionItems.map((item) => [item.id, item])),
    [allSessionItems],
  );
  sessionItemByIdRef.current = sessionItemById;

  useEffect(() => {
    document.documentElement.dataset.appRuntime = "preact";
    document.body.classList.toggle("locked", !signedIn && !(sharedSessionId && sharedToken));
  }, [signedIn, sharedSessionId, sharedToken]);

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
  const desktopHostID = desktopViewerHostID();
  const desktopHost = (props.state.fleet?.desktopHosts || []).find(
    (host) => host.id === desktopHostID && host.relayCapable === true,
  );
  useEffect(() => {
    const onKeyDown = (event) => handleAppEscape(event, props);
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [props.dialog, props.drawers]);

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
      {desktopHostID && props.signedIn ? (
        <DesktopViewer host={desktopHost} onExit={() => location.assign("/app/fleet")} />
      ) : (
        <AppShell {...props} />
      )}
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
