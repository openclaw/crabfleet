import { render } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { useAppData } from "./app-data.js";
import { AppShell } from "./app-shell.jsx";
import { Icon } from "./components.jsx";
import { ActionDialog, Drawer, useActionDialog } from "./dialogs.jsx";
import { LoginScreen } from "./login.jsx";
import { isLoginScreenHidden } from "./login-state.js";
import {
  appViewUrl,
  initialAppView,
  parseSessionLink,
  restoreSessionReturnUrl,
  sessionRouteUrl,
} from "./routing.js";
import {
  defaultSessionLayout,
  loadSessionLayout,
  moveSessionLayoutItem,
  orderedSessionItems,
  saveSessionLayout,
} from "./session-layout.js";
import {
  canDeleteInteractiveWorkspace,
  canMaintain,
  elapsed,
  hasRunCapability,
  humanStatus,
  issueNumber,
  isActiveRun,
  isDeadInteractiveSession,
  isProvisioningInteractiveSession,
  interactiveSessionStatus,
  linkedInteractiveSessionPlaceholder,
  optimisticInteractiveSession,
  preferredRepo,
  preferredRepos,
  runCapabilities,
  runtimeCapabilityLabel,
  runtimeProfileOptionLabel,
  sessionLogsUrl,
  sessionItems,
  terminalText,
  titleFromPrompt,
} from "./utils.js";
import {
  configureTerminalHub,
  disposeAllTerminals,
  disposeTerminal,
  disposeMissingTerminals,
  mountTerminal,
  warmGhosttyModule,
} from "./terminal.js";

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

function CardDrawer({ drawers, closeDrawer, createCard, state }) {
  const [busy, setBusy] = useState(false);
  return (
    <Drawer
      id="card-drawer"
      open={drawers.card}
      title="New card"
      onClose={() => closeDrawer("card")}
    >
      <form
        class="form-grid"
        aria-busy={busy ? "true" : "false"}
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await createCard(event.currentTarget);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Source
          <select name="source">
            <option>Prompt</option>
            <option>Issue</option>
            <option>PR</option>
          </select>
        </label>
        <RepoSelect repos={state.repos} name="repo" preferred={state.deployment?.preferredRepo} />
        <label class="full">
          Title (optional)
          <input name="title" placeholder="Generated from prompt if blank" />
        </label>
        <label class="full">
          Prompt
          <textarea name="prompt" required placeholder="Describe the Codex task" />
        </label>
        <label>
          Runtime
          <select name="runtime">
            <option>auto</option>
            <option>container</option>
            <option>crabbox</option>
          </select>
        </label>
        <label>
          Merge policy
          <select name="policy">
            <option value="">repo default</option>
            <option>open_pr</option>
            <option>merge_when_green</option>
            <option>fix_until_green_and_merge</option>
          </select>
        </label>
        <div class="actions full">
          <button type="button" disabled={busy} onClick={() => closeDrawer("card")}>
            Cancel
          </button>
          <button class="primary" type="submit" disabled={busy}>
            {busy ? "Creating..." : "Create"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}

function InteractiveDrawer({ drawers, closeDrawer, createInteractiveSession, state }) {
  const [busy, setBusy] = useState(false);
  const defaultRuntime = state.deployment?.defaultRuntime || "container";
  const defaultProfile = state.deployment?.defaultProfile || "default";
  const runtimeProfiles = state.deployment?.runtimeProfiles || [];
  const [runtime, setRuntime] = useState(defaultRuntime);
  useEffect(() => setRuntime(defaultRuntime), [defaultRuntime]);
  return (
    <Drawer
      id="interactive-drawer"
      open={drawers.interactive}
      title="New Crabbox"
      onClose={() => closeDrawer("interactive")}
    >
      <form
        class="form-grid"
        aria-busy={busy ? "true" : "false"}
        onReset={() => setRuntime(defaultRuntime)}
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await createInteractiveSession(event.currentTarget);
          } finally {
            setBusy(false);
          }
        }}
      >
        <RepoSelect repos={state.repos} name="repo" preferred={state.deployment?.preferredRepo} />
        <label>
          Branch
          <input name="branch" defaultValue="main" placeholder="main" />
        </label>
        <label>
          Runtime
          <select
            name="runtime"
            value={runtime}
            onChange={(event) => setRuntime(event.currentTarget.value)}
          >
            <option value="container">Cloudflare Sandbox</option>
            <option value="crabbox">Crabbox</option>
          </select>
        </label>
        {runtime === "crabbox" && runtimeProfiles.length > 0 ? (
          <label>
            Profile
            <select key={defaultProfile} name="profile" defaultValue={defaultProfile}>
              {runtimeProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {runtimeProfileOptionLabel(profile)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <input type="hidden" name="profile" value={defaultProfile} />
        )}
        <label>
          Command
          <input name="command" defaultValue="codex --yolo" placeholder="codex --yolo" />
        </label>
        <label class="full">
          Prompt (optional)
          <textarea name="prompt" placeholder="Initial note for the interactive box" />
        </label>
        <div class="actions full">
          <button type="button" disabled={busy} onClick={() => closeDrawer("interactive")}>
            Cancel
          </button>
          <button class="primary" type="submit" disabled={busy}>
            {busy ? "Provisioning..." : "Create crabbox"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}

function RepoSelect({ repos, name, preferred = preferredRepo }) {
  const values = preferredRepos(repos, preferred);
  return (
    <label>
      Repo
      <select name={name} defaultValue={values.includes(preferred) ? preferred : values[0]}>
        {values.map((repo) => (
          <option>{repo}</option>
        ))}
      </select>
    </label>
  );
}

function RunDrawer({ drawers, closeDrawer, activeRunId, state, cardAction }) {
  const card = state.cards.find((item) => item.id === activeRunId);
  return (
    <Drawer
      id="run-drawer"
      open={drawers.run}
      title={card ? `${card.id} - ${card.title}` : "Run"}
      wide
      onClose={() => closeDrawer("run")}
    >
      <div class="run-layout">
        <div class="run-main">
          <pre class="terminal">{card?.logs?.join("\n") || ""}</pre>
          <DiffPanel card={card} />
        </div>
        <aside class="sidebox">
          {card ? <RunSide card={card} state={state} cardAction={cardAction} /> : null}
        </aside>
      </div>
    </Drawer>
  );
}

function DiffPanel({ card }) {
  const files = card?.changes?.files || [];
  const patch = card?.changes?.patch || "";
  if (!files.length) return <section class="diff-panel" hidden />;
  return (
    <section class="diff-panel">
      <div class="diff-head">
        <strong>Changed files</strong>
        <span>
          {files.length} files · +{card.changes.totals.additions} -{card.changes.totals.deletions}
        </span>
      </div>
      {files.map((file) => (
        <details key={file.path} open>
          <summary>
            <span>{file.path}</span>
            <span>
              +{file.additions} -{file.deletions}
            </span>
          </summary>
          {file.patch ? <pre>{file.patch}</pre> : null}
        </details>
      ))}
      <pre>{patch || "No patch preview"}</pre>
    </section>
  );
}

function RunSide({ card, state, cardAction }) {
  const capabilities = runCapabilities(card);
  const capabilityLabel = Object.entries(capabilities)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(", ");
  const maintain = canMaintain(state.user);
  return (
    <>
      <h3>Session</h3>
      <div class="kv">
        <span>
          Repo <strong>{card.repo}</strong>
        </span>
        <span>
          Runtime <strong>{card.run?.runtime || card.runtime}</strong>
        </span>
        <span>
          Run <strong>{card.run?.id || "none"}</strong>
        </span>
        <span>
          Merge <strong>{card.policy}</strong>
        </span>
        <span>
          Status <strong>{card.run?.status || card.lane}</strong>
        </span>
        <span>
          Capabilities <strong>{capabilityLabel || "none"}</strong>
        </span>
      </div>
      <h3>Capabilities</h3>
      <div class="kv">
        {Object.entries(capabilities).map(([key, value]) => (
          <span>
            {key} <strong>{value ? "yes" : "no"}</strong>
          </span>
        ))}
      </div>
      <button onClick={() => cardAction(card.id, "watch")}>Watch</button>
      {maintain && hasRunCapability(card, "takeover") ? (
        <button class="primary" onClick={() => cardAction(card.id, "takeover")}>
          Take over
        </button>
      ) : null}
      {maintain && isActiveRun(card) ? (
        <button onClick={() => cardAction(card.id, "stall")}>Mark stalled</button>
      ) : null}
    </>
  );
}

function SessionsDrawer(props) {
  const open = Boolean(props.drawers.sessions);
  const focusedCandidate = props.focusedSessionId
    ? props.sessionItemById.get(props.focusedSessionId)
    : null;
  const focused = focusedCandidate && isSessionGridItem(focusedCandidate) ? focusedCandidate : null;
  const gridItems = props.allSessionItems.filter(isSessionGridItem);
  const sessions = focused ? [focused] : orderedSessionItems(gridItems, props.sessionLayout);
  const singleSession = sessions.length === 1;
  useEffect(() => {
    if (!open) return;
    disposeMissingTerminals(new Set(sessions.map((session) => session.id)));
  }, [open, sessions.map((session) => session.id).join("\0")]);
  return (
    <div
      class={`drawer ${open ? "open" : ""}`}
      id="sessions-drawer"
      aria-hidden={open ? "false" : "true"}
    >
      <section class="panel session-panel">
        <div class="panel-head session-head">
          <div>
            <h2>Codex sessions</h2>
            <p>Live Codex CLI terminals with shareable read access.</p>
          </div>
          <SessionTools focused={Boolean(focused)} {...props} />
        </div>
        <div class="panel-body">
          <section
            class={`session-grid ${props.sessionLayout.columns !== "auto" && !focused ? "fixed-columns" : ""} ${
              props.sessionLayout.edit && !focused ? "layout-editing" : ""
            } ${focused ? "focus-mode" : ""} ${singleSession ? "single-session" : ""}`}
            style={{
              "--session-columns":
                props.sessionLayout.columns !== "auto" && !focused
                  ? props.sessionLayout.columns
                  : "1",
            }}
            aria-label="Codex session grid"
          >
            {sessions.length ? (
              sessions.map((session) => (
                <SessionCell
                  key={session.id}
                  session={session}
                  focused={Boolean(focused)}
                  singleSession={singleSession}
                  drawerOpen={open}
                  {...props}
                />
              ))
            ) : (
              <div class="session-empty">
                <button
                  class="primary session-empty-action"
                  disabled={!canMaintain(props.state.user)}
                  onClick={() => props.openDrawer("interactive")}
                >
                  New Codex session
                </button>
                <span>No Codex sessions yet</span>
              </div>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}

function SessionTools({
  focused,
  sessionLayout,
  setSessionLayout,
  closeDrawer,
  openDrawer,
  showSessionGrid,
  cleanupDeadInteractiveSessions,
  state,
}) {
  const deadCount = (state.interactiveSessions || []).filter((session) =>
    canCleanInteractiveSession(session, state.user),
  ).length;
  return (
    <div class="session-tools">
      <button
        class="primary"
        disabled={!canMaintain(state.user)}
        onClick={() => openDrawer("interactive")}
      >
        New session
      </button>
      <label class="session-columns-field">
        <span>Columns</span>
        <select
          name="session-columns"
          value={focused ? "1" : sessionLayout.columns}
          disabled={focused}
          onChange={(event) =>
            setSessionLayout((layout) => ({ ...layout, columns: event.currentTarget.value }))
          }
        >
          {["auto", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].map((value) => (
            <option value={value}>{value === "auto" ? "Auto" : value}</option>
          ))}
        </select>
      </label>
      <details class="session-layout-menu">
        <summary>Layout</summary>
        <div class="session-layout-popover">
          <button
            disabled={focused}
            class={sessionLayout.edit && !focused ? "primary" : ""}
            onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
              setSessionLayout((layout) => ({ ...layout, edit: !layout.edit }));
            }}
          >
            {sessionLayout.edit && !focused ? "Done editing" : "Edit layout"}
          </button>
          <button
            disabled={focused}
            onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
              setSessionLayout(defaultSessionLayout(true));
            }}
          >
            Reset
          </button>
        </div>
      </details>
      <button onClick={showSessionGrid} hidden={!focused}>
        Grid
      </button>
      {deadCount ? (
        <button class="danger" onClick={cleanupDeadInteractiveSessions}>
          Clean dead ({deadCount})
        </button>
      ) : null}
      <button class="icon" aria-label="Close sessions" onClick={() => closeDrawer("sessions")}>
        <Icon name="x" />
      </button>
    </div>
  );
}

function SessionCell(props) {
  const session = props.session;
  const editable = props.sessionLayout.edit && !props.focused;
  const branchLabel =
    session.kind === "interactive"
      ? session.branch && session.branch !== "main"
        ? session.branch
        : ""
      : session.branch || session.policy || "";
  return (
    <article
      class={`session-cell ${editable ? "layout-editing" : ""}`}
      draggable={editable}
      data-session-cell={session.id}
      onDragStart={(event) => {
        if (!editable) return;
        props.draggedSessionId.current = session.id;
        event.currentTarget.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", session.id);
      }}
      onDragOver={(event) => {
        if (
          !props.draggedSessionId.current ||
          !editable ||
          props.draggedSessionId.current === session.id
        )
          return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        event.currentTarget.classList.add("drop-target");
      }}
      onDragLeave={(event) => event.currentTarget.classList.remove("drop-target")}
      onDrop={(event) => {
        const sourceId = props.draggedSessionId.current;
        event.currentTarget.classList.remove("drop-target");
        if (!sourceId || sourceId === session.id) return;
        event.preventDefault();
        props.draggedSessionId.current = null;
        props.setSessionLayout((layout) =>
          moveSessionLayoutItem(layout, props.allSessionItems, sourceId, session.id),
        );
      }}
      onDragEnd={(event) => {
        props.draggedSessionId.current = null;
        event.currentTarget.classList.remove("dragging", "drop-target");
      }}
    >
      <header class="session-cell-head">
        <div class="session-cell-title">
          <strong>{session.repo}</strong>
          {branchLabel ? <span>{branchLabel}</span> : null}
        </div>
        <SessionStatus session={session} />
        <div class="session-controls">
          {editable ? <SessionLayoutButtons session={session} {...props} /> : null}
          {!props.focused && !editable ? (
            <button
              onClick={() => {
                props.setFocusedSessionId(session.id);
                props.openSessionGrid(session.id, { deepLink: session.kind === "interactive" });
              }}
            >
              Maximize
            </button>
          ) : null}
          <SessionActions session={session} minimal={!props.focused && !editable} {...props} />
        </div>
      </header>
      <div class="session-terminal-wrap">
        <TerminalMount
          key={terminalMountKey(session)}
          session={session}
          focused={props.focused}
          singleSession={props.singleSession}
          drawerOpen={props.drawerOpen}
        />
      </div>
      <footer class="session-cell-foot">
        <span>{sessionFooterSummary(session)}</span>
        <span>{sessionTerminalStatusLabel(session, props.terminalStatus)}</span>
      </footer>
    </article>
  );
}

function terminalMountKey(session) {
  if (session.kind !== "interactive") return session.id;
  return [session.id, session.command, session.leaseId || ""].join(":");
}

function isLocalInteractiveSession(session) {
  return session?.kind === "interactive" && String(session.id).startsWith("LOCAL-");
}

function sessionTerminalStatusLabel(session, terminalStatus) {
  if (session.kind === "interactive" && isDeadInteractiveSession(session)) return "Log replay";
  return terminalStatus[session.id] || runtimeCapabilityLabel(session);
}

function SessionLayoutButtons() {
  return (
    <span class="session-edit-controls">
      <button class="session-drag layout-control" draggable="true" title="Drag to rearrange">
        Move
      </button>
    </span>
  );
}

function SessionActions(props) {
  const session = props.session;
  if (session.kind === "interactive") return <InteractiveSessionActions {...props} />;
  if (props.minimal) {
    return (
      <>
        <button onClick={() => props.openRunDetails(session.id)}>Details</button>
      </>
    );
  }
  return (
    <>
      <button onClick={() => props.openRunDetails(session.id)}>Details</button>
      <button onClick={() => props.cardAction(session.id, "watch")}>Watch</button>
      {canMaintain(props.state.user) && hasRunCapability(session, "takeover") ? (
        <button onClick={() => props.cardAction(session.id, "takeover")}>Take over</button>
      ) : null}
    </>
  );
}

function InteractiveSessionActions(props) {
  const session = props.session;
  if (String(session.id).startsWith("LOCAL-")) return null;
  const stopped = isDeadInteractiveSession(session);
  const ending = session.status === "stopping";
  const deletesWorkspace = canDeleteInteractiveWorkspace(session);
  const endsWorkflowSession = session.runtime === "github_actions";
  const endLabel = stopped
    ? "Clean up"
    : ending
      ? deletesWorkspace
        ? "Deleting…"
        : endsWorkflowSession
          ? "Ending…"
          : "Stopping…"
      : deletesWorkspace
        ? "Delete"
        : endsWorkflowSession
          ? "End"
          : "Stop";
  const canManage = session.canManage || canMaintain(props.state.user);
  const canChangeMultiplayer = Boolean(session.canChangeMultiplayer);
  const shareAction = session.shareMode === "link_read" ? "disable_share" : "share_link";
  const shareLabel = session.shareMode === "link_read" ? "Unshare" : "Share";
  const multiplayerAction = session.multiplayerMode ? "disable_multiplayer" : "enable_multiplayer";
  const multiplayerLabel = session.multiplayerMode ? "Solo input" : "Multiplayer";
  const multiplayerTooltip = session.multiplayerMode
    ? 'Multiplayer attribution is on. Submitted prompts are prepended with a <sender name=""/> tag for the model.'
    : 'Turn on multiplayer attribution. Submitted prompts will be prepended with a <sender name=""/> tag for the model.';
  const handleShare = () => {
    if (shareAction === "disable_share")
      return props.interactiveSessionAction(session.id, shareAction);
    return props.shareInteractiveSession(session.id);
  };
  if (props.minimal) {
    return (
      <>
        {session.vncUrl ? (
          <button onClick={() => window.open(session.vncUrl, "_blank", "noopener")}>VNC</button>
        ) : null}
        <button onClick={() => window.open(sessionLogsUrl(session.id), "_blank", "noopener")}>
          Logs
        </button>
        {canManage ? <button onClick={handleShare}>{shareLabel}</button> : null}
        {canChangeMultiplayer ? (
          <button
            aria-pressed={session.multiplayerMode}
            title={multiplayerTooltip}
            onClick={() => props.interactiveSessionAction(session.id, multiplayerAction)}
          >
            {multiplayerLabel}
          </button>
        ) : null}
        {canManage ? (
          <button
            class="danger"
            disabled={ending}
            onClick={() =>
              stopped
                ? props.cleanupInteractiveSession(session.id)
                : props.deleteInteractiveSession(session.id)
            }
          >
            {endLabel}
          </button>
        ) : null}
      </>
    );
  }
  return (
    <>
      {session.vncUrl ? (
        <button onClick={() => window.open(session.vncUrl, "_blank", "noopener")}>VNC</button>
      ) : null}
      {!session.sharedReadOnly ? (
        <button onClick={() => window.open(sessionLogsUrl(session.id), "_blank", "noopener")}>
          Logs
        </button>
      ) : null}
      {canManage ? <button onClick={handleShare}>{shareLabel}</button> : null}
      {canChangeMultiplayer ? (
        <button
          aria-pressed={session.multiplayerMode}
          title={multiplayerTooltip}
          onClick={() => props.interactiveSessionAction(session.id, multiplayerAction)}
        >
          {multiplayerLabel}
        </button>
      ) : null}
      {session.canRequestControl && !session.sharedReadOnly && !stopped ? (
        <button onClick={() => props.interactiveSessionAction(session.id, "request_control")}>
          {session.controlRequestedBy ? "Control requested" : "Request control"}
        </button>
      ) : null}
      {canManage && session.controlRequestedBy ? (
        <>
          <button
            class="primary"
            onClick={() => props.interactiveSessionAction(session.id, "approve_control")}
          >
            Allow
          </button>
          <button onClick={() => props.interactiveSessionAction(session.id, "deny_control")}>
            Deny
          </button>
        </>
      ) : null}
      {canManage && session.controller ? (
        <button onClick={() => props.interactiveSessionAction(session.id, "revoke_control")}>
          Revoke
        </button>
      ) : null}
      {canManage ? (
        <button
          class="danger"
          disabled={ending}
          onClick={() =>
            stopped
              ? props.cleanupInteractiveSession(session.id)
              : props.deleteInteractiveSession(session.id)
          }
        >
          {endLabel}
        </button>
      ) : null}
    </>
  );
}

function canCleanInteractiveSession(session, user) {
  return isDeadInteractiveSession(session) && (session.canManage || canMaintain(user));
}

function isSessionGridItem(session) {
  if (session?.kind === "interactive") return true;
  return session?.kind === "card" && isActiveRun(session);
}

function SessionStatus({ session }) {
  const status = sessionStatus(session);
  return <span class={`session-status ${status.tone}`}>{status.label}</span>;
}

function sessionStatus(session) {
  if (session.kind === "interactive") {
    return interactiveSessionStatus(session);
  }
  if (session.run?.status === "failed" || session.lane === "Human Review") {
    return { label: humanStatus(session.run?.status || session.lane), tone: "failed" };
  }
  if (session.lane === "Running") return { label: "Live", tone: "live" };
  if (session.lane === "Done") return { label: "Done", tone: "stopped" };
  return { label: session.lane || humanStatus(session.run?.status), tone: "" };
}

function sessionFooterSummary(session) {
  if (session.kind === "interactive") {
    const parts = [session.id];
    const seen = session.lastHeartbeatAt || session.lastSeenAt || session.updatedAt;
    if (seen) parts.push(`seen ${elapsed(seen)}`);
    if (session.workKind) parts.push(humanStatus(session.workKind));
    if (session.workState) parts.push(humanStatus(session.workState));
    if (session.workPhase) parts.push(humanStatus(session.workPhase));
    if (session.status) parts.push(humanStatus(session.status));
    if (session.shareMode === "link_read" || session.sharedReadOnly) parts.push("shared");
    if (session.multiplayerMode) parts.push("multiplayer");
    if (session.controller) parts.push(`control ${session.controller}`);
    if (session.controlRequestedBy) parts.push(`request ${session.controlRequestedBy}`);
    return parts.join(" · ");
  }
  const parts = [session.id];
  if (session.run?.lastHeartbeatAt || session.startedAt) {
    parts.push(`seen ${elapsed(session.run?.lastHeartbeatAt || session.startedAt)}`);
  }
  if (session.run?.status) parts.push(humanStatus(session.run.status));
  if (session.run?.runtime || session.runtime) parts.push(session.run?.runtime || session.runtime);
  return parts.join(" · ");
}

function TerminalMount({ session, focused, singleSession, drawerOpen }) {
  const ref = useRef(null);
  const hideTimer = useRef(null);
  const mountedSessionId = useRef(null);
  const [visible, setVisible] = useState(focused);
  const provisioning = isProvisioningInteractiveSession(session);
  const localSession = isLocalInteractiveSession(session);
  const endedSession = session.kind === "interactive" && isDeadInteractiveSession(session);

  useLayoutEffect(
    () => () => {
      if (mountedSessionId.current) disposeTerminal(mountedSessionId.current);
      mountedSessionId.current = null;
    },
    [],
  );

  useEffect(() => {
    const clearHideTimer = () => {
      if (!hideTimer.current) return;
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    };
    if (focused || singleSession) {
      clearHideTimer();
      setVisible(true);
      return;
    }
    if (!drawerOpen) {
      clearHideTimer();
      setVisible(false);
      return;
    }
    const mount = ref.current;
    if (!mount || !("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    const root = mount.closest(".panel-body");
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          clearHideTimer();
          setVisible(true);
          return;
        }
        clearHideTimer();
        hideTimer.current = setTimeout(() => {
          hideTimer.current = null;
          setVisible(false);
        }, 900);
      },
      {
        root,
        rootMargin: "360px 0px",
        threshold: 0,
      },
    );
    observer.observe(mount);
    return () => {
      observer.disconnect();
      clearHideTimer();
    };
  }, [session.id, focused, singleSession, drawerOpen]);

  useLayoutEffect(() => {
    const mount = ref.current;
    if (!mount) return;
    const active = drawerOpen && visible && !localSession && !provisioning && !endedSession;
    if (mountedSessionId.current && mountedSessionId.current !== session.id) {
      disposeTerminal(mountedSessionId.current);
      mountedSessionId.current = null;
    }
    mount.dataset.sessionId = active ? session.id : "";
    if (!active) {
      if (mountedSessionId.current) {
        disposeTerminal(mountedSessionId.current);
        mountedSessionId.current = null;
      }
      mount.innerHTML = "";
      return;
    }
    mountedSessionId.current = session.id;
    void mountTerminal(session, mount, { focused });
  }, [session, focused, drawerOpen, visible, provisioning, localSession, endedSession]);

  const terminalActive = drawerOpen && visible && !localSession && !provisioning && !endedSession;

  return (
    <div class="ghostty-terminal" aria-label={`${session.id} terminal`}>
      <div
        ref={ref}
        class="terminal-surface"
        data-session-id={terminalActive ? session.id : ""}
        hidden={!terminalActive}
      />
      {provisioning ? (
        <TerminalProvisioning session={session} />
      ) : localSession ? (
        <TerminalLocalStatus session={session} />
      ) : endedSession ? (
        <TerminalEndedTranscript session={session} />
      ) : !visible ? (
        <div class="terminal-placeholder">Terminal paused offscreen</div>
      ) : null}
    </div>
  );
}

function TerminalEndedTranscript({ session }) {
  return (
    <pre class="terminal-fallback terminal-ended" aria-label={`${session.id} log replay`}>
      {terminalText(session)}
    </pre>
  );
}

function TerminalProvisioning({ session }) {
  return (
    <div class="terminal-provisioning">
      <span class="terminal-progress" aria-hidden="true" />
      <strong>{session.routePlaceholder ? "Loading Codex" : "Preparing Codex"}</strong>
      <span>{session.repo || "Codex session"}</span>
      <small>{terminalProvisioningDetail(session)}</small>
    </div>
  );
}

function TerminalLocalStatus({ session }) {
  return (
    <div class={`terminal-provisioning ${session.status === "failed" ? "failed" : ""}`}>
      <span class="terminal-progress" aria-hidden="true" />
      <strong>{humanStatus(session.status || "Pending")}</strong>
      <span>{session.repo || "Codex session"}</span>
      <small>{session.lastEvent || session.logs?.at?.(-1) || "Waiting for session id"}</small>
    </div>
  );
}

function terminalProvisioningDetail(session) {
  if (session.status === "pending_adapter") return "Runtime adapter pending";
  if (isLocalInteractiveSession(session)) return session.lastEvent || "Requesting workspace";
  if (session.routePlaceholder) return "Opening shared session";
  return "Provisioning sandbox and terminal";
}

function AdminDrawer(props) {
  const owner = props.state.user?.role === "owner";
  return (
    <Drawer
      id="admin-drawer"
      open={props.drawers.admin}
      title="Admin"
      wide
      onClose={() => props.closeDrawer("admin")}
    >
      <div class="admin-grid">
        <AdminList
          title="Users and teams"
          placeholder="@login or @org/team"
          disabled={!owner}
          select={{
            values: [
              ["maintainer", "Maintainer"],
              ["owner", "Owner"],
              ["viewer", "Viewer"],
            ],
          }}
          rows={props.state.allow.map((item) => ({
            label: `${item.value} - ${item.role}`,
            value: item.value,
          }))}
          onAdd={(value, role) => props.addAllow(value, role)}
          onRemove={props.removeAllow}
        />
        <AdminList
          title="Repos"
          placeholder="owner/repo"
          disabled={!owner}
          rows={props.state.repos.map((repo) => ({ label: repo, value: repo }))}
          onAdd={props.addRepo}
          onRemove={props.removeRepo}
        />
        <PolicyBox disabled={!owner} state={props.state} updatePolicy={props.updatePolicy} />
        <WorkflowBox
          disabled={!owner}
          workflows={props.state.workflows || []}
          refreshWorkflow={props.refreshWorkflow}
          preferred={props.state.deployment?.preferredRepo}
        />
      </div>
    </Drawer>
  );
}

function AdminList({ title, placeholder, disabled, select, rows, onAdd, onRemove }) {
  const [value, setValue] = useState("");
  const [role, setRole] = useState(select?.values?.[0]?.[0] || "");
  return (
    <section class="admin-box">
      <h3>{title}</h3>
      <div class="form-grid">
        <input
          class="full"
          name="admin-entry"
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
        {select ? (
          <select
            class="full"
            name="admin-role"
            value={role}
            disabled={disabled}
            onChange={(event) => setRole(event.currentTarget.value)}
          >
            {select.values.map(([key, label]) => (
              <option value={key}>{label}</option>
            ))}
          </select>
        ) : null}
        <button
          class="primary full"
          disabled={disabled}
          onClick={() => {
            if (!value.trim()) return;
            void onAdd(value.trim(), role);
            setValue("");
          }}
        >
          Add
        </button>
      </div>
      <div class="list">
        {rows.map((row) => (
          <div class="list-row">
            <span>{row.label}</span>
            <button
              class="icon"
              disabled={disabled}
              aria-label={`Remove ${row.label}`}
              onClick={() => onRemove(row.value)}
            >
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function PolicyBox({ disabled, state, updatePolicy }) {
  const [cap, setCap] = useState(state.cap);
  const [merge, setMerge] = useState(state.merge);
  const [retention, setRetention] = useState(state.retention);
  useEffect(() => {
    setCap(state.cap);
    setMerge(state.merge);
    setRetention(state.retention);
  }, [state.cap, state.merge, state.retention]);
  return (
    <section class="admin-box">
      <h3>Policy</h3>
      <label>
        Concurrent cap
        <input
          type="number"
          name="concurrent-cap"
          min="1"
          max="200"
          value={cap}
          disabled={disabled}
          onInput={(event) => setCap(event.currentTarget.value)}
        />
      </label>
      <label>
        Direct merge
        <select
          name="merge-policy"
          value={merge}
          disabled={disabled}
          onChange={(event) => setMerge(event.currentTarget.value)}
        >
          <option value="guarded">Guarded</option>
          <option value="disabled">Disabled</option>
          <option value="maintainers">Maintainers only</option>
        </select>
      </label>
      <label>
        Log retention
        <select
          name="log-retention"
          value={retention}
          disabled={disabled}
          onChange={(event) => setRetention(event.currentTarget.value)}
        >
          <option value="30">30 days</option>
          <option value="14">14 days</option>
          <option value="60">60 days</option>
        </select>
      </label>
      <button
        class="primary"
        disabled={disabled}
        onClick={() => {
          const rawCap = Number(cap);
          updatePolicy({
            cap: Number.isFinite(rawCap) ? Math.min(200, Math.max(1, rawCap)) : 20,
            retention,
            merge,
          });
        }}
      >
        Save policy
      </button>
      <div class="kv">
        <span>
          Secrets: <strong>per org, referenced only</strong>
        </span>
        <span>
          VNC: <strong>Crabbox leases only</strong>
        </span>
      </div>
    </section>
  );
}

function WorkflowBox({ disabled, workflows, refreshWorkflow, preferred = preferredRepo }) {
  const [repo, setRepo] = useState(preferred);
  useEffect(() => setRepo(preferred), [preferred]);
  return (
    <section class="admin-box">
      <h3>Workflows</h3>
      <div class="form-grid">
        <input
          class="full"
          name="workflow-repo"
          placeholder={preferred}
          value={repo}
          disabled={disabled}
          onInput={(event) => setRepo(event.currentTarget.value)}
        />
        <button
          class="primary full"
          disabled={disabled}
          onClick={() => refreshWorkflow(repo.trim())}
        >
          Refresh CRABBOX.md
        </button>
      </div>
      <div class="list">
        {workflows.length ? (
          workflows.map((workflow) => {
            const config = workflow.config || {};
            const detail = [
              config.runtime ? `runtime=${config.runtime}` : "",
              config.policy ? `policy=${config.policy}` : "",
              workflow.error || "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div class="list-row">
                <span>
                  {workflow.repo} - {workflow.status}
                  {detail ? (
                    <>
                      <br />
                      <small>{detail}</small>
                    </>
                  ) : null}
                </span>
              </div>
            );
          })
        ) : (
          <div class="empty">No workflow evaluations</div>
        )}
      </div>
    </section>
  );
}

function isTerminalKeyTarget(event) {
  const active = document.activeElement;
  return Boolean(
    event.target?.closest?.(".ghostty-terminal") || active?.closest?.(".ghostty-terminal"),
  );
}

render(
  <App />,
  document.getElementById("crabfleet-preact-root") ||
    document.getElementById("crabbox-preact-root"),
);
