import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AdminDrawer } from "./admin-drawer.jsx";
import { api } from "./api.js";
import { useAppData } from "./app-data.js";
import { AppShell } from "./app-shell.jsx";
import { ActionDialog, useActionDialog } from "./dialogs.jsx";
import { LoginScreen } from "./login.jsx";
import { isLoginScreenHidden } from "./login-state.js";
import {
  appViewUrl,
  initialAppView,
  parseSessionLink,
  restoreSessionReturnUrl,
  sessionRouteUrl,
} from "./routing.js";
import { loadSessionLayout, saveSessionLayout } from "./session-layout.js";
import { canCleanInteractiveSession, isTerminalKeyTarget } from "./session-state.js";
import { SessionsDrawer } from "./session-workspace.jsx";
import {
  canDeleteInteractiveWorkspace,
  issueNumber,
  linkedInteractiveSessionPlaceholder,
  optimisticInteractiveSession,
  sessionItems,
  titleFromPrompt,
} from "./utils.js";
import {
  configureTerminalHub,
  disposeAllTerminals,
  disposeTerminal,
  warmGhosttyModule,
} from "./terminal.js";
import { CardDrawer, InteractiveDrawer, RunDrawer } from "./work-drawers.jsx";

function App() {
  const initialSessionLink = useMemo(() => {
    restoreSessionReturnUrl();
    return parseSessionLink();
  }, []);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [appView, setAppViewState] = useState(initialAppView);
  const [drawers, setDrawers] = useState(initialSessionLink.route ? { sessions: true } : {});
  const [activeRunId, setActiveRunId] = useState(null);
  const [focusedSessionId, setFocusedSessionId] = useState(initialSessionLink.id);
  const [sharedSessionId, setSharedSessionId] = useState(initialSessionLink.id);
  const [sharedToken, setSharedToken] = useState(initialSessionLink.token);
  const [initialSessionOpened, setInitialSessionOpened] = useState(false);
  const [refPreview, setRefPreview] = useState({
    number: "",
    loading: false,
    matches: [],
    error: "",
  });
  const [theme, setThemeState] = useState(
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  const { dialog, openActionDialog, closeActionDialog, confirmActionDialog } = useActionDialog();
  const [sessionLayout, setSessionLayout] = useState(loadSessionLayout);
  const [terminalStatus, setTerminalStatus] = useState({});
  const focusedSessionIdRef = useRef(focusedSessionId);
  const refPreviewTimer = useRef(null);
  const refPreviewSeq = useRef(0);
  const draggedSessionId = useRef(null);
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

  const allSessionItems = useMemo(() => sessionItems(state), [state]);
  const sessionItemById = useMemo(
    () => new Map(allSessionItems.map((item) => [item.id, item])),
    [allSessionItems],
  );

  focusedSessionIdRef.current = focusedSessionId;
  useEffect(() => {
    return () => {
      if (refPreviewTimer.current) clearTimeout(refPreviewTimer.current);
      disposeAllTerminals();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.appRuntime = "preact";
    document.body.classList.toggle("locked", !signedIn && !(sharedSessionId && sharedToken));
  }, [signedIn, sharedSessionId, sharedToken]);

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

  function findCard(id) {
    return stateRef.current.cards.find((card) => card.id === id);
  }

  function findInteractiveSession(id) {
    return (stateRef.current.interactiveSessions || []).find((session) => session.id === id);
  }

  function upsertCard(card) {
    setState((current) => ({
      ...current,
      cards: current.cards.map((item) => (item.id === card.id ? card : item)),
    }));
  }

  function upsertInteractiveSession(session) {
    setState((current) => {
      const sessions = current.interactiveSessions || [];
      return {
        ...current,
        interactiveSessions: sessions.some((item) => item.id === session.id)
          ? sessions.map((item) => (item.id === session.id ? session : item))
          : [session, ...sessions],
      };
    });
  }

  function removeInteractiveSession(id) {
    setState((current) => ({
      ...current,
      interactiveSessions: (current.interactiveSessions || []).filter(
        (session) => session.id !== id,
      ),
    }));
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
    const next = value === "board" ? "board" : "fleet";
    setAppViewState(next);
    closeAllDrawers();
    if (!history.pushState) return;
    history.pushState(null, "", appViewUrl(location.href, next));
  }

  function closeTopDrawer() {
    const order = ["card", "interactive", "run", "sessions", "admin"];
    const id = order.findLast((key) => drawers[key]);
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
    const targetId = id === undefined ? focusedSessionIdRef.current : id;
    if (targetId) setFocusedSessionId(targetId);
    else if (id === null) setFocusedSessionId(null);
    const deepLink =
      options.deepLink ??
      Boolean(targetId && sessionItemById.get(targetId)?.kind === "interactive");
    const urlSessionId =
      targetId && deepLink && !String(targetId).startsWith("LOCAL-") ? targetId : null;
    if (urlSessionId) setSessionUrl(urlSessionId);
    else if (!sharedToken) setSessionUrl(null, { grid: true });
    warmGhosttyModule();
    setDrawers((current) => ({ ...current, sessions: true }));
  }

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

  function setTheme(value) {
    setThemeState(value === "light" ? "light" : "dark");
  }

  async function cardAction(id, action) {
    const result = await api(`/api/cards/${encodeURIComponent(id)}/actions`, {
      method: "POST",
      body: { action },
    });
    upsertCard(result.card);
  }

  async function attachCard(id) {
    const result = await api(`/api/cards/${encodeURIComponent(id)}/actions`, {
      method: "POST",
      body: { action: "attach" },
    });
    upsertCard(result.card);
    openSessionGrid(id);
  }

  async function interactiveSessionAction(id, action) {
    const result = await api(`/api/interactive-sessions/${encodeURIComponent(id)}/actions`, {
      method: "POST",
      body: { action },
    });
    upsertInteractiveSession(result.session);
    if (action === "stop") return result;
    openSessionGrid(id, { deepLink: true });
    return result;
  }

  function deleteInteractiveSession(id) {
    const session = findInteractiveSession(id);
    const label = session ? `${session.repo} (${session.id})` : id;
    const deletesWorkspace = canDeleteInteractiveWorkspace(session);
    const endsWorkflowSession = session?.runtime === "github_actions";
    openActionDialog({
      kind: "danger",
      eyebrow: deletesWorkspace
        ? "Live workspace"
        : endsWorkflowSession
          ? "Live workflow terminal"
          : "Live session",
      title: deletesWorkspace
        ? "Delete Crabbox workspace?"
        : endsWorkflowSession
          ? "End GitHub Actions terminal session?"
          : "Stop Crabbox session?",
      description: deletesWorkspace
        ? "This releases the runtime workspace and cannot be undone. Its final status and logs stay visible in Crabfleet."
        : endsWorkflowSession
          ? "This ends the Crabfleet terminal session and disconnects it. It does not cancel the GitHub Actions workflow run, which may continue on GitHub. Final Crabfleet logs stay visible."
          : "This stops Crabfleet access and marks the session stopped. This legacy backend does not expose provider deletion, so its runtime may require separate cleanup.",
      subject: label,
      confirmLabel: deletesWorkspace
        ? "Delete workspace"
        : endsWorkflowSession
          ? "End session"
          : "Stop session",
      action: () => interactiveSessionAction(id, "stop"),
    });
  }

  async function cleanupInteractiveSessions(ids) {
    const result = await api("/api/interactive-sessions/cleanup", {
      method: "POST",
      body: { ids },
    });
    setState(result.state);
    const removed = new Set(result.removedIds || []);
    if (removed.has(focusedSessionIdRef.current)) {
      setFocusedSessionId(null);
      if (!sharedToken) setSessionUrl(null, { grid: true });
    }
    for (const id of removed) disposeTerminal(id);
    return result;
  }

  function cleanupInteractiveSession(id) {
    const session = findInteractiveSession(id);
    const label = session ? `${session.repo} (${session.id})` : id;
    openActionDialog({
      kind: "danger",
      eyebrow: "Dead session",
      title: "Clean up Codex session?",
      description:
        "This permanently removes the session record, event history, and archived logs from Crabfleet.",
      subject: label,
      confirmLabel: "Clean up",
      action: async () => {
        if (session?.routePlaceholder) {
          removeInteractiveSession(id);
          if (focusedSessionIdRef.current === id) setFocusedSessionId(null);
          if (!sharedToken) setSessionUrl(null, { grid: true });
          return;
        }
        await cleanupInteractiveSessions([id]);
      },
    });
  }

  function cleanupDeadInteractiveSessions() {
    const user = stateRef.current.user;
    const ids = (stateRef.current.interactiveSessions || [])
      .filter((session) => canCleanInteractiveSession(session, user))
      .map((session) => session.id);
    if (!ids.length) return null;
    openActionDialog({
      kind: "danger",
      eyebrow: "Fleet cleanup",
      title: `Clean up ${ids.length} dead Codex session${ids.length === 1 ? "" : "s"}?`,
      description:
        "This permanently removes their session records, event history, and archived logs from Crabfleet.",
      subject: ids.length === 1 ? ids[0] : `${ids.length} stopped or failed sessions`,
      confirmLabel: `Clean up ${ids.length}`,
      action: () => cleanupInteractiveSessions(ids),
    });
  }

  async function shareInteractiveSession(id) {
    const result = await interactiveSessionAction(id, "share_link");
    if (!result.shareUrl) return;
    let copied = false;
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(result.shareUrl);
        copied = true;
      }
    } catch {}
    if (!copied) {
      openActionDialog({
        kind: "share",
        eyebrow: "Read-only access",
        title: "Share link ready",
        description: "Clipboard access is unavailable. Copy this link manually.",
        value: result.shareUrl,
      });
    }
  }

  async function openRunDetails(id) {
    closeDrawer("sessions");
    setActiveRunId(id);
    let card = findCard(id);
    if (!card) return;
    try {
      const result = await api(`/api/cards/${encodeURIComponent(id)}/actions`, {
        method: "POST",
        body: { action: "attach" },
      });
      upsertCard(result.card);
      card = result.card;
    } catch (error) {
      setLoginMessage(error.message);
      return;
    }
    openDrawer("run");
  }

  function scheduleRefPreview(value) {
    const number = issueNumber(value);
    refPreviewSeq.current += 1;
    if (refPreviewTimer.current) clearTimeout(refPreviewTimer.current);
    if (!number) {
      setRefPreview({ number: "", loading: false, matches: [], error: "" });
      return;
    }
    setRefPreview({ number, loading: true, matches: [], error: "" });
    const seq = refPreviewSeq.current;
    refPreviewTimer.current = setTimeout(() => loadRefPreview(number, seq), 220);
  }

  async function loadRefPreview(number, seq) {
    try {
      const result = await api(`/api/github/refs?number=${encodeURIComponent(number)}`);
      if (seq !== refPreviewSeq.current) return;
      setRefPreview({ number, loading: false, matches: result.matches || [], error: "" });
    } catch (error) {
      if (seq !== refPreviewSeq.current) return;
      setRefPreview({
        number,
        loading: false,
        matches: [],
        error: error.message || "GitHub lookup failed",
      });
    }
  }

  async function createRefCard(index) {
    const match = refPreview.matches[index];
    if (!match) return;
    await api("/api/cards", {
      method: "POST",
      body: {
        title: `${match.repo}#${match.number}: ${match.title}`,
        prompt: `${match.source} ${match.url}\n\n${match.title}\n\n${match.body || ""}`,
        repo: match.repo,
        source: match.source,
        runtime: "auto",
        policy: "",
      },
    });
    setRefPreview({ number: "", loading: false, matches: [], error: "" });
    setSearch("");
    await refreshState();
  }

  async function createCard(form) {
    const data = new FormData(form);
    await api("/api/cards", {
      method: "POST",
      body: {
        title: data.get("title") || titleFromPrompt(data.get("prompt")),
        prompt: data.get("prompt"),
        repo: data.get("repo"),
        source: data.get("source"),
        runtime: data.get("runtime"),
        policy: data.get("policy"),
      },
    });
    form.reset();
    closeDrawer("card");
    await refreshState();
  }

  async function createInteractiveSession(form) {
    const data = new FormData(form);
    const optimistic = optimisticInteractiveSession(
      data,
      state.user?.login,
      state.deployment?.runtimeProfiles,
    );
    upsertInteractiveSession(optimistic);
    closeDrawer("interactive");
    setFocusedSessionId(optimistic.id);
    openSessionGrid(optimistic.id);
    try {
      const result = await api("/api/interactive-sessions", {
        method: "POST",
        body: {
          repo: data.get("repo"),
          branch: data.get("branch"),
          runtime: data.get("runtime"),
          profile: data.get("profile"),
          command: data.get("command"),
          prompt: data.get("prompt"),
        },
      });
      removeInteractiveSession(optimistic.id);
      upsertInteractiveSession(result.session);
      form.reset();
      form.elements.branch.value = "main";
      form.elements.command.value = "codex --yolo";
      setFocusedSessionId(result.session.id);
      openSessionGrid(result.session.id, { deepLink: true });
    } catch (error) {
      upsertInteractiveSession({
        ...optimistic,
        status: "failed",
        lastEvent: error.message || "session creation failed",
        logs: [error.message || "session creation failed"],
      });
      setLoginMessage(error.message || "session creation failed");
    }
  }

  async function addAllow(value, role) {
    setState(await api("/api/admin/allow", { method: "POST", body: { value, role } }));
  }

  async function removeAllow(value) {
    setState(await api(`/api/admin/allow/${encodeURIComponent(value)}`, { method: "DELETE" }));
  }

  async function addRepo(repo) {
    setState(await api("/api/admin/repos", { method: "POST", body: { repo } }));
  }

  async function removeRepo(repo) {
    setState(await api(`/api/admin/repos/${encodeURIComponent(repo)}`, { method: "DELETE" }));
  }

  async function refreshWorkflow(repo) {
    setState(await api("/api/admin/workflows/evaluate", { method: "POST", body: { repo } }));
  }

  async function updatePolicy(policy) {
    setState(await api("/api/admin/policy", { method: "PUT", body: policy }));
  }

  function updateSessionLayout(updater) {
    setSessionLayout((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      saveSessionLayout(next);
      return next;
    });
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
    search,
    setSearch: (value) => {
      setSearch(value);
      scheduleRefPreview(value);
    },
    drawers,
    activeRunId,
    focusedSessionId,
    sharedSessionId,
    sharedToken,
    setFocusedSessionId,
    showSessionGrid,
    refPreview,
    theme,
    dialog,
    terminalStatus,
    sessionLayout,
    setSessionLayout: updateSessionLayout,
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
    cardAction,
    attachCard,
    interactiveSessionAction,
    deleteInteractiveSession,
    cleanupInteractiveSession,
    cleanupDeadInteractiveSessions,
    shareInteractiveSession,
    openRunDetails,
    createRefCard,
    createCard,
    createInteractiveSession,
    addAllow,
    removeAllow,
    addRepo,
    removeRepo,
    refreshWorkflow,
    updatePolicy,
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
