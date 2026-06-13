import { render } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { CopyCommand, Icon } from "./components.jsx";
import { FleetPage } from "./fleet.jsx";
import {
  canMaintain,
  canOwn,
  elapsed,
  hasRunCapability,
  humanStatus,
  issueNumber,
  isActiveRun,
  isDeadInteractiveSession,
  isFleetSessionAttachable,
  isProvisioningInteractiveSession,
  interactiveSessionStatus,
  lanes,
  linkedInteractiveSessionPlaceholder,
  optimisticInteractiveSession,
  preferredRepo,
  preferredRepos,
  runCapabilities,
  runtimeCapabilityLabel,
  sessionLogsUrl,
  sessionItems,
  statusLabel,
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

const logo = "__CRABBOX_LOGO__";
const productName = "Crabfleet";
const productDomain = "crabfleet.openclaw.ai";
const sshHost = "crabd.sh";
const defaultDeployment = {
  label: productName,
  canonicalUrl: `https://${productDomain}`,
  productUrl: "https://crabfleet.ai",
  sshHost,
  preferredRepo,
  defaultRuntime: "container",
  defaultProfile: "default",
};
const loginReturnKey = "crabbox-login-return";
const skipAutoGithubLoginKey = "crabbox-skip-auto-github-login";
const githubAutoLoginReadyKey = "crabbox-github-auto-login-ready";
const sessionLayoutStorageKey = "crabbox-session-layout-v1";
const emptyState = {
  cards: [],
  interactiveSessions: [],
  fleet: null,
  allow: [],
  repos: [],
  workflows: [],
  cap: 20,
  retention: "30",
  merge: "guarded",
  deployment: defaultDeployment,
};
function initialState(initialSessionLink) {
  if (!initialSessionLink.id) return emptyState;
  return {
    ...emptyState,
    interactiveSessions: [
      linkedInteractiveSessionPlaceholder(initialSessionLink.id, {
        sharedReadOnly: Boolean(initialSessionLink.token),
      }),
    ],
  };
}

function App() {
  const githubLoginCallback = useRef(isGithubLoginCallback());
  const initialSessionLink = useMemo(() => {
    restoreSessionReturnUrl();
    return parseSessionLink();
  }, []);
  const [state, setState] = useState(() => initialState(initialSessionLink));
  const [signedIn, setSignedIn] = useState(false);
  const [authMethods, setAuthMethods] = useState({
    github: false,
    token: false,
    devIdentity: false,
  });
  const [loginMessage, setLoginMessage] = useState("");
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
  const [dialog, setDialog] = useState(null);
  const [sessionLayout, setSessionLayout] = useState(loadSessionLayout);
  const [terminalStatus, setTerminalStatus] = useState({});
  const stateRef = useRef(state);
  const authMethodsRef = useRef(authMethods);
  const signedInRef = useRef(signedIn);
  const activeRunIdRef = useRef(activeRunId);
  const focusedSessionIdRef = useRef(focusedSessionId);
  const drawersRef = useRef(drawers);
  const sharedRef = useRef({ id: sharedSessionId, token: sharedToken });
  const stateRetryTimer = useRef(null);
  const refPreviewTimer = useRef(null);
  const refPreviewSeq = useRef(0);
  const draggedSessionId = useRef(null);
  const autoLoginStarted = useRef(false);
  const dialogSequence = useRef(0);

  const allSessionItems = useMemo(() => sessionItems(state), [state]);
  const sessionItemById = useMemo(
    () => new Map(allSessionItems.map((item) => [item.id, item])),
    [allSessionItems],
  );

  stateRef.current = state;
  authMethodsRef.current = authMethods;
  signedInRef.current = signedIn;
  activeRunIdRef.current = activeRunId;
  focusedSessionIdRef.current = focusedSessionId;
  drawersRef.current = drawers;
  sharedRef.current = { id: sharedSessionId, token: sharedToken };

  useEffect(() => {
    void loadState();
    const interval = setInterval(() => {
      if (signedInRef.current) {
        void loadState();
        return;
      }
      const shared = sharedRef.current;
      if (shared.id && shared.token && !document.body.classList.contains("locked")) {
        loadSharedSession().catch((error) => {
          if (error.status === 403 || error.status === 404) {
            void showSharedLinkError(error);
            return;
          }
          console.warn("Shared session refresh failed", error);
        });
      }
    }, 15000);
    return () => {
      clearInterval(interval);
      if (stateRetryTimer.current) clearTimeout(stateRetryTimer.current);
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
    if (!signedIn && !loginMessage) void maybeAutoGithubLogin(authMethods);
  }, [signedIn, loginMessage, authMethods.github, sharedSessionId, sharedToken]);

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

  async function loadState() {
    try {
      const nextState = await api("/api/state", { authOptional: true });
      const linkedSessionId = sharedRef.current.id;
      const linkedSession = linkedSessionId ? findInteractiveSession(linkedSessionId) : null;
      if (
        linkedSession &&
        !(nextState.interactiveSessions || []).some((session) => session.id === linkedSessionId)
      ) {
        nextState.interactiveSessions = [linkedSession, ...(nextState.interactiveSessions || [])];
      }
      const activeRunId = activeRunIdRef.current;
      const activeCard = nextState.cards.find((card) => card.id === activeRunId);
      if (activeRunId && drawersRef.current.run && activeCard?.changes?.files?.length) {
        const result = await api(`/api/cards/${encodeURIComponent(activeRunId)}/actions`, {
          method: "POST",
          body: { action: "attach" },
        });
        nextState.cards = nextState.cards.map((card) =>
          card.id === result.card.id ? result.card : card,
        );
      }
      if (stateRetryTimer.current) clearTimeout(stateRetryTimer.current);
      stateRetryTimer.current = null;
      setAuthMethods(nextState.auth || authMethodsRef.current);
      setState(nextState);
      setSignedIn(true);
      setLoginMessage("");
      finishGithubLoginCallback(true);
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        const shared = sharedRef.current;
        if (shared.id && shared.token) {
          try {
            await loadSharedSession();
          } catch (sharedError) {
            await showSharedLinkError(sharedError);
          }
          return;
        }
        const methods = await loadAuthMethods();
        finishGithubLoginCallback(false);
        if (error.status === 401 && (await maybeAutoGithubLogin(methods))) return;
        closeAllDrawers();
        setSignedIn(false);
        setLoginMessage(error.message === "unauthorized" ? "" : error.message);
        return;
      }
      setLoginMessage(error.message);
      stateRetryTimer.current ||= setTimeout(() => {
        stateRetryTimer.current = null;
        void loadState();
      }, 5000);
    }
  }

  async function loadSharedSession() {
    const result = await api(
      `/api/shared-sessions/${encodeURIComponent(sharedSessionId)}?token=${encodeURIComponent(sharedToken)}`,
      { authOptional: true },
    );
    await loadAuthMethods();
    setState({
      user: { subject: "shared", login: "shared link", role: "viewer" },
      auth: authMethods,
      org: "OpenClaw",
      cap: 20,
      retention: "30",
      merge: "guarded",
      allow: [],
      repos: [result.session.repo],
      workflows: [],
      cards: [],
      interactiveSessions: [result.session],
      deployment: stateRef.current.deployment || defaultDeployment,
    });
    setSignedIn(false);
    setFocusedSessionId(result.session.id);
    openSessionGrid(result.session.id, { deepLink: true });
  }

  async function loadLinkedInteractiveSession(id) {
    const result = await api(`/api/interactive-sessions/${encodeURIComponent(id)}`);
    upsertInteractiveSession(result.session);
    setInitialSessionOpened(true);
    setFocusedSessionId(result.session.id);
    openSessionGrid(result.session.id, { deepLink: true });
  }

  async function showSharedLinkError(error) {
    await loadAuthMethods();
    closeAllDrawers();
    setSharedSessionId(null);
    setSharedToken(null);
    setFocusedSessionId(null);
    setInitialSessionOpened(true);
    setSessionUrl(null);
    setSignedIn(false);
    setLoginMessage(
      error?.status === 404
        ? "Shared session link is invalid or expired."
        : error?.message || "Shared session could not be loaded.",
    );
  }

  async function loadAuthMethods() {
    try {
      const result = await api("/api/auth", { authOptional: true });
      const methods = result.auth || authMethodsRef.current;
      if (result.deployment) {
        setState((current) => ({ ...current, deployment: result.deployment }));
      }
      setAuthMethods(methods);
      return methods;
    } catch {
      const methods = { github: false, token: true, devIdentity: false };
      setAuthMethods(methods);
      return methods;
    }
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
    const url = new URL(location.href);
    url.pathname = next === "board" ? "/app/board" : "/app/fleet";
    url.search = "";
    history.pushState(null, "", url);
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
    if (id) {
      const url = new URL(location.href);
      url.pathname = `/sessions/${encodeURIComponent(id)}`;
      url.search = "";
      if (sharedToken && id === sharedSessionId) url.searchParams.set("token", sharedToken);
      history.replaceState(null, "", url);
      return;
    }
    const url = new URL(location.href);
    url.pathname = options.grid ? "/sessions" : appView === "board" ? "/app/board" : "/app/fleet";
    url.search = "";
    history.replaceState(null, "", url);
  }

  function setTheme(value) {
    setThemeState(value === "light" ? "light" : "dark");
  }

  function openActionDialog(options) {
    dialogSequence.current += 1;
    setDialog({
      id: dialogSequence.current,
      pending: false,
      error: "",
      ...options,
    });
  }

  function closeActionDialog() {
    setDialog((current) => (current?.pending ? current : null));
  }

  async function confirmActionDialog() {
    const current = dialog;
    if (!current?.action || current.pending) return;
    setDialog((value) =>
      value?.id === current.id ? { ...value, pending: true, error: "" } : value,
    );
    try {
      await current.action();
      setDialog((value) => (value?.id === current.id ? null : value));
    } catch (error) {
      setDialog((value) =>
        value?.id === current.id
          ? {
              ...value,
              pending: false,
              error: error?.message || "The action could not be completed.",
            }
          : value,
      );
    }
  }

  async function beginLogin() {
    try {
      sessionStorage.removeItem(skipAutoGithubLoginKey);
    } catch {}
    preserveLoginReturnUrl();
    let methods = authMethods;
    if (!methods.github && !methods.token) methods = await loadAuthMethods();
    if (methods.github) {
      location.href = "/login/github";
      return;
    }
    setLoginMessage("Sign in to request terminal control.");
  }

  async function tokenLogin(token) {
    try {
      await api("/api/login/token", { method: "POST", body: { token }, authOptional: true });
      await loadState();
    } catch (error) {
      setLoginMessage(String(error.message || error));
    }
  }

  async function devIdentityLogin(identity) {
    try {
      await api("/api/login/dev", {
        method: "POST",
        body: identity,
        authOptional: true,
      });
      await loadState();
    } catch (error) {
      setLoginMessage(String(error.message || error));
    }
  }

  async function logout() {
    try {
      sessionStorage.setItem(skipAutoGithubLoginKey, "1");
      localStorage.removeItem(githubAutoLoginReadyKey);
    } catch {}
    autoLoginStarted.current = false;
    await api("/api/logout", { method: "POST", authOptional: true });
    await loadState();
  }

  async function maybeAutoGithubLogin(methods = authMethodsRef.current) {
    if (signedInRef.current || autoLoginStarted.current || !methods?.github) return false;
    if (methods.devIdentity) return false;
    if (methods.token && wantsTokenLoginBypass()) return false;
    const shared = sharedRef.current;
    if (shared.id && shared.token) return false;
    try {
      if (sessionStorage.getItem(skipAutoGithubLoginKey) === "1") return false;
      if (localStorage.getItem(githubAutoLoginReadyKey) !== "1") return false;
    } catch {
      return false;
    }
    autoLoginStarted.current = true;
    preserveLoginReturnUrl();
    location.href = "/login/github";
    return true;
  }

  function preserveLoginReturnUrl() {
    try {
      if (sharedRef.current.id) sessionStorage.setItem(loginReturnKey, location.href);
    } catch {}
  }

  function wantsTokenLoginBypass() {
    const params = new URLSearchParams(location.search);
    return params.get("auth") === "token";
  }

  function finishGithubLoginCallback(remember) {
    if (!githubLoginCallback.current) return;
    githubLoginCallback.current = false;
    if (remember) {
      try {
        localStorage.setItem(githubAutoLoginReadyKey, "1");
      } catch {}
    }
    if (!history.replaceState) return;
    const url = new URL(location.href);
    if (url.searchParams.get("login") !== "github") return;
    url.searchParams.delete("login");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
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

  function closeInteractiveSession(id) {
    const session = findInteractiveSession(id);
    const label = session ? `${session.repo} (${session.id})` : id;
    openActionDialog({
      kind: "danger",
      eyebrow: "Live session",
      title: "End Codex session?",
      description: "This stops the terminal. Its final status and logs stay visible in Crabfleet.",
      subject: label,
      confirmLabel: "End session",
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
    await loadState();
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
    await loadState();
  }

  async function createInteractiveSession(form) {
    const data = new FormData(form);
    const optimistic = optimisticInteractiveSession(data, state.user?.login);
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
    closeInteractiveSession,
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
        hidden={
          props.signedIn ||
          Boolean(props.sharedSessionId && props.sharedToken && !props.loginMessage) ||
          (props.state.user?.subject === "shared" && !props.loginMessage)
        }
        authMethods={props.authMethods}
        deployment={props.state.deployment || defaultDeployment}
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

const devIdentityPresets = [
  { id: "admin-1", name: "Admin 1", role: "owner" },
  { id: "admin-2", name: "Admin 2", role: "owner" },
  { id: "user-1", name: "User 1", role: "maintainer" },
  { id: "user-2", name: "User 2", role: "viewer" },
];

function LoginScreen({
  hidden,
  authMethods,
  deployment = defaultDeployment,
  message,
  onGithub,
  onToken,
  onDevIdentity,
}) {
  const [token, setToken] = useState("");
  return (
    <section class="login-screen" hidden={hidden}>
      <a class="login-back" href="/docs/">
        &larr; documentation
      </a>
      <InfrastructureField />
      <form
        class="login-panel"
        onSubmit={(event) => {
          event.preventDefault();
          void onToken(token);
          setToken("");
        }}
      >
        <div class="login-brand">
          <div class="mark">
            <img src={logo} alt="" />
          </div>
          <h1>{deployment.label}</h1>
        </div>
        <p>Managed crabboxes, SSH-first.</p>
        <div class="login-actions">
          <button
            class="primary github-login"
            type="button"
            hidden={!authMethods.github}
            disabled={!authMethods.github}
            onClick={onGithub}
          >
            <Icon name="git-pull-request" />
            Sign in with GitHub
          </button>
          <div class="command-row">
            <span>Or connect via</span>
            <CopyCommand value={`ssh link@${deployment.sshHost}`} />
          </div>
          <details
            class="bootstrap-login"
            hidden={!authMethods.token}
            {...(authMethods.token && !authMethods.github && !authMethods.devIdentity
              ? { open: true }
              : {})}
          >
            <summary>Use bootstrap token</summary>
            <div class="bootstrap-login-fields">
              <label>
                Bootstrap token
                <input
                  type="password"
                  name="bootstrap-token"
                  autocomplete="current-password"
                  disabled={!authMethods.token}
                  value={token}
                  onInput={(event) => setToken(event.currentTarget.value)}
                />
              </label>
              <button type="submit" disabled={!authMethods.token}>
                Use token
              </button>
            </div>
          </details>
        </div>
        <DevIdentityPanel
          hidden={!authMethods.devIdentity}
          user={null}
          onDevIdentity={onDevIdentity}
        />
        <div class={`banner ${message ? "show" : ""}`}>{message}</div>
        <div class="login-footer">
          <a href="/docs/">Documentation</a>
        </div>
      </form>
    </section>
  );
}

const infraBlocks = [
  { x: "50%", y: "31%", w: "86px", h: "48px", o: "0.95", d: "0s" },
  { x: "41%", y: "39%", w: "92px", h: "44px", o: "0.56", d: "-1.1s" },
  { x: "59%", y: "39%", w: "86px", h: "38px", o: "0.5", d: "-2.4s" },
  { x: "34%", y: "49%", w: "104px", h: "42px", o: "0.34", d: "-3.1s" },
  { x: "66%", y: "49%", w: "106px", h: "46px", o: "0.33", d: "-0.8s" },
  { x: "27%", y: "61%", w: "96px", h: "36px", o: "0.24", d: "-2.2s" },
  { x: "73%", y: "61%", w: "96px", h: "36px", o: "0.24", d: "-1.8s" },
  { x: "43%", y: "64%", w: "106px", h: "42px", o: "0.3", d: "-3.7s" },
  { x: "57%", y: "65%", w: "100px", h: "40px", o: "0.28", d: "-0.5s" },
  { x: "18%", y: "73%", w: "112px", h: "38px", o: "0.19", d: "-2.9s" },
  { x: "82%", y: "73%", w: "108px", h: "38px", o: "0.18", d: "-4.1s" },
  { x: "34%", y: "80%", w: "98px", h: "36px", o: "0.18", d: "-0.3s" },
  { x: "67%", y: "81%", w: "96px", h: "36px", o: "0.16", d: "-2.7s" },
  { x: "50%", y: "87%", w: "104px", h: "34px", o: "0.12", d: "-3.5s" },
];

function InfrastructureField() {
  return (
    <div class="infra-field" aria-hidden="true">
      {infraBlocks.map((block, index) => (
        <span
          class={index === 0 ? "infra-block focus" : "infra-block"}
          style={{
            "--x": block.x,
            "--y": block.y,
            "--w": block.w,
            "--h": block.h,
            "--o": block.o,
            "--d": block.d,
          }}
        />
      ))}
    </div>
  );
}

function AppShell(props) {
  const deployment = props.state.deployment || defaultDeployment;
  const active = props.state.cards.filter((card) => card.lane === "Running").length;
  const queue = props.state.cards.filter((card) => card.lane === "Todo").length;
  const review = props.state.cards.filter((card) => card.lane === "Human Review").length;
  const cli =
    props.state.fleet?.totals?.attachable ??
    (props.state.interactiveSessions || []).filter(isFleetSessionAttachable).length;
  const user = props.state.user;
  const userLabel =
    !props.signedIn && user?.subject === "shared"
      ? "Sign in for control"
      : user
        ? `${user.login || user.email || user.subject} / ${user.role}`
        : "Signed out";
  return (
    <div class="app">
      <aside class="rail" aria-label="Primary">
        <div class="brand-lockup" title={deployment.canonicalUrl}>
          <div class="mark">
            <img src={logo} alt="" />
          </div>
          <span>{deployment.label}</span>
        </div>
        <div class="nav-actions">
          <button
            class={props.appView === "fleet" ? "active" : ""}
            title="Fleet"
            aria-label="Fleet"
            onClick={() => props.setAppView("fleet")}
          >
            <Icon name="layout-grid" />
            <span>Fleet</span>
          </button>
          <button
            class={props.appView === "board" ? "active" : ""}
            title="Board"
            aria-label="Board"
            onClick={() => props.setAppView("board")}
          >
            <Icon name="square-terminal" />
            <span>Board</span>
          </button>
          <button
            title="Admin"
            aria-label="Admin"
            disabled={!canOwn(user)}
            onClick={() => props.openDrawer("admin")}
          >
            <Icon name="settings" />
            <span>Admin</span>
          </button>
          <button
            title="Sessions"
            aria-label="Sessions"
            onClick={() => props.openSessionGrid(null)}
          >
            <Icon name="terminal" />
            <span>Sessions</span>
          </button>
        </div>
        <div class="spacer" />
        <button
          class="theme-toggle"
          title={`Switch to ${props.theme === "dark" ? "light" : "dark"} mode`}
          aria-label={`Switch to ${props.theme === "dark" ? "light" : "dark"} mode`}
          onClick={() => props.setTheme(props.theme === "dark" ? "light" : "dark")}
        >
          <Icon name={props.theme === "dark" ? "sun" : "moon"} />
        </button>
        <button
          class="spec-link"
          title="Spec"
          aria-label="Spec"
          onClick={() => (location.href = "/docs/spec")}
        >
          <Icon name="book-open" />
        </button>
      </aside>
      <main class="shell">
        <section class="top">
          <div class="title">
            <h1>{props.appView === "board" ? "Board" : deployment.label}</h1>
            <p>
              {props.appView === "board"
                ? "Prompt cards and run attempts, separated from the live crabbox fleet."
                : "All visible Codex crabboxes grouped by person, with SSH, WebVNC, and session supervision."}
            </p>
          </div>
          <button
            class="ghost user-chip"
            onClick={props.signedIn ? props.logout : props.beginLogin}
          >
            {userLabel}
          </button>
        </section>
        <DevIdentityPanel
          hidden={!props.authMethods.devIdentity || !props.signedIn}
          user={user}
          onDevIdentity={props.devIdentityLogin}
        />
        {props.appView === "board" ? (
          <BoardPage user={user} {...props} />
        ) : (
          <FleetPage
            active={active}
            queue={queue}
            review={review}
            cli={cli}
            userLabel={userLabel}
            {...props}
          />
        )}
      </main>
    </div>
  );
}

function BoardPage(props) {
  return (
    <section class="board-page" aria-label="Crabfleet board page">
      <section class="toolbar">
        <div class="search-wrap">
          <input
            type="search"
            name="board-search"
            placeholder="Search cards, repos, runs, #76552"
            value={props.search}
            onInput={(event) => props.setSearch(event.currentTarget.value)}
          />
          <RefPreview
            preview={props.refPreview}
            canCreate={canMaintain(props.user)}
            onCreate={props.createRefCard}
          />
        </div>
        <div class="segmented" aria-label="Board filter">
          {["all", "mine", "hot"].map((key) => (
            <button
              class={props.filter === key ? "active" : ""}
              onClick={() => props.setFilter(key)}
            >
              {key === "all" ? "All" : key === "mine" ? "Mine" : "Live"}
            </button>
          ))}
        </div>
        <button
          class="primary"
          disabled={!canMaintain(props.user)}
          onClick={() => props.openDrawer("card")}
        >
          New card
        </button>
        <button disabled={!canMaintain(props.user)} onClick={() => props.openDrawer("interactive")}>
          New crabbox
        </button>
        <button disabled={!canOwn(props.user)} onClick={() => props.openDrawer("admin")}>
          Admin
        </button>
      </section>
      <Board {...props} />
    </section>
  );
}

function DevIdentityPanel({ hidden, user, onDevIdentity }) {
  const currentId = user?.subject?.startsWith("dev:")
    ? user.subject.slice("dev:".length)
    : user?.login || "admin-1";
  const currentName = user?.name || user?.login || "Admin 1";
  const currentRole = user?.role || "owner";
  const [id, setId] = useState(currentId);
  const [name, setName] = useState(currentName);
  const [role, setRole] = useState(currentRole);

  useEffect(() => {
    if (hidden) return;
    setId(currentId);
    setName(currentName);
    setRole(currentRole);
  }, [hidden, currentId, currentName, currentRole]);

  async function submit(identity) {
    setId(identity.id);
    setName(identity.name);
    setRole(identity.role);
    await onDevIdentity(identity);
  }

  return (
    <div
      class="dev-identity-panel"
      hidden={hidden}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        void submit({ id, name, role });
      }}
    >
      <div class="dev-identity-title">Dev identity</div>
      <div class="dev-identity-presets">
        {devIdentityPresets.map((preset) => (
          <button type="button" onClick={() => void submit(preset)}>
            {preset.name}
          </button>
        ))}
      </div>
      <label>
        ID
        <input
          name="dev-identity-id"
          autocomplete="username"
          value={id}
          onInput={(event) => setId(event.currentTarget.value)}
        />
      </label>
      <label>
        Name
        <input
          name="dev-identity-name"
          autocomplete="name"
          value={name}
          onInput={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label>
        Role
        <select
          name="dev-identity-role"
          value={role}
          onInput={(event) => setRole(event.currentTarget.value)}
        >
          <option value="owner">Owner</option>
          <option value="maintainer">Maintainer</option>
          <option value="viewer">Viewer</option>
        </select>
      </label>
      <button class="primary" type="button" onClick={() => void submit({ id, name, role })}>
        Apply
      </button>
    </div>
  );
}

function RefPreview({ preview, canCreate, onCreate }) {
  if (!preview.number) return <div class="ref-preview" hidden />;
  const title = preview.loading
    ? `Looking up #${preview.number}`
    : `Matches for #${preview.number}`;
  return (
    <div class="ref-preview">
      <div class="ref-preview-head">
        <span>{title}</span>
        <span>{preview.matches.length || ""}</span>
      </div>
      {preview.loading ? (
        <div class="ref-empty">Searching allowed OpenClaw repos...</div>
      ) : preview.error ? (
        <div class="ref-empty">{preview.error}</div>
      ) : preview.matches.length ? (
        <div class="ref-preview-list">
          {preview.matches.map((match, index) => (
            <div class="ref-row">
              <div>
                <div class="ref-title">{match.title}</div>
                <div class="ref-meta">
                  <span class="chip">
                    {match.repo}#{match.number}
                  </span>
                  <span class="chip merge">{match.source}</span>
                  <span class="chip">{match.state}</span>
                  {match.author ? <span class="chip">@{match.author}</span> : null}
                </div>
              </div>
              {canCreate ? (
                <button class="primary" onClick={() => onCreate(index)}>
                  New card
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div class="ref-empty">No issue or PR #{preview.number} in enabled repos.</div>
      )}
    </div>
  );
}

function Board(props) {
  const current = props.state.user?.login || props.state.user?.email || props.state.user?.subject;
  const query = props.search.trim().toLowerCase();
  const visibleCards = props.state.cards.filter((card) => {
    if (props.filter === "mine" && card.owner !== current) return false;
    if (props.filter === "hot" && card.lane !== "Running") return false;
    return matchesCard(card, query);
  });
  return (
    <section class="board" aria-label="Crabfleet board">
      {lanes.map((lane) => {
        const cards = visibleCards.filter((card) => card.lane === lane);
        return (
          <section class="lane" key={lane}>
            <div class="lane-head">
              <span>{lane}</span>
              <small>{cards.length}</small>
            </div>
            <div class="cards">
              {cards.length ? (
                cards.map((card) => <Card key={card.id} card={card} {...props} />)
              ) : (
                <div class="empty">No cards</div>
              )}
            </div>
          </section>
        );
      })}
    </section>
  );
}

function matchesCard(card, query) {
  if (!query) return true;
  const changedPaths = (card.changes?.files || []).map((file) => file.path).join(" ");
  return [card.id, card.title, card.repo, card.source, card.runtime, card.policy, changedPaths]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function Card({ card, state, cardAction, attachCard }) {
  const cls =
    card.lane === "Running"
      ? "running"
      : card.lane === "Human Review"
        ? "review"
        : card.lane === "Done"
          ? "done"
          : "";
  const maintain = canMaintain(state.user);
  return (
    <article class={`card ${cls}`}>
      <div>
        <h3>{card.title}</h3>
        <p>{card.prompt}</p>
      </div>
      <div class="meta">
        <span class="chip">{card.id}</span>
        <span class="chip">{card.repo}</span>
        <span class="chip">{card.runtime}</span>
        {card.run ? <span class="chip">{card.run.id}</span> : null}
        <span class="chip merge">{card.policy}</span>
        {card.lane === "Running" ? (
          <span class="chip hot">
            {card.run?.status || "live"} {elapsed(card.run?.lastHeartbeatAt || card.startedAt)}
          </span>
        ) : null}
      </div>
      <ChangeCard changes={card.changes} />
      <div class="card-actions">
        {maintain ? (
          <button onClick={() => cardAction(card.id, card.lane === "Running" ? "pulse" : "start")}>
            {card.lane === "Running" ? "Pulse" : "Start"}
          </button>
        ) : null}
        <button onClick={() => attachCard(card.id)}>Attach</button>
        {maintain ? <button onClick={() => cardAction(card.id, "advance")}>Move</button> : null}
      </div>
    </article>
  );
}

function ChangeCard({ changes }) {
  const value = changes || { files: [], totals: { additions: 0, deletions: 0 } };
  if (!value.files.length) return null;
  return (
    <div class="change-card" aria-label="Changed files">
      <div class="change-card-head">
        <span>Diff</span>
        <span>{value.files.length} files</span>
        <span class="change-delta">
          <span class="add">+{value.totals.additions}</span>{" "}
          <span class="del">-{value.totals.deletions}</span>
        </span>
      </div>
      {value.files.slice(0, 3).map((file) => (
        <div class="change-file">
          <span class={`status-badge ${file.status}`}>{statusLabel(file.status)}</span>
          <span class="change-path" title={file.path}>
            {file.path}
          </span>
          <span class="change-delta">
            <span class="add">+{Number(file.additions) || 0}</span>{" "}
            <span class="del">-{Number(file.deletions) || 0}</span>
          </span>
        </div>
      ))}
      {value.files.length > 3 ? <span>+{value.files.length - 3} more</span> : null}
    </div>
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
            key={state.deployment?.defaultRuntime || "container"}
            name="runtime"
            defaultValue={state.deployment?.defaultRuntime || "container"}
          >
            <option value="container">Cloudflare Sandbox</option>
            <option value="crabbox">Crabbox</option>
          </select>
        </label>
        <input type="hidden" name="profile" value={state.deployment?.defaultProfile || "default"} />
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
            onClick={() =>
              stopped
                ? props.cleanupInteractiveSession(session.id)
                : props.closeInteractiveSession(session.id)
            }
          >
            {stopped ? "Clean up" : "Close"}
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
          onClick={() =>
            stopped
              ? props.cleanupInteractiveSession(session.id)
              : props.closeInteractiveSession(session.id)
          }
        >
          {stopped ? "Clean up" : "Close"}
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

function Drawer({ id, open, title, wide, onClose, children }) {
  const elementRef = useRef(null);
  const titleId = `${id}-title`;

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!open || !element) return;
    const previousFocus = document.activeElement;
    if (!element.open) element.showModal();
    element
      .querySelector(
        ".panel-body input, .panel-body select, .panel-body textarea, .panel-body button",
      )
      ?.focus();
    return () => {
      if (element.open) element.close();
      previousFocus?.focus?.();
    };
  }, [open]);

  return (
    <dialog
      ref={elementRef}
      class={`drawer ${open ? "open" : ""}`}
      id={id}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <section class={`panel ${wide ? "wide" : ""}`}>
        <div class="panel-head">
          <h2 id={titleId}>{title}</h2>
          <button class="icon" aria-label={`Close ${title}`} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div class="panel-body">{children}</div>
      </section>
    </dialog>
  );
}

function ActionDialog({ dialog, onCancel, onConfirm }) {
  const elementRef = useRef(null);
  const cancelRef = useRef(null);
  const valueRef = useRef(null);
  const [copied, setCopied] = useState(false);

  useLayoutEffect(() => {
    if (!dialog) return;
    const element = elementRef.current;
    const previousFocus = document.activeElement;
    setCopied(false);
    if (element && !element.open) element.showModal();
    const focusTarget = dialog.kind === "share" ? valueRef.current : cancelRef.current;
    focusTarget?.focus();
    if (dialog.kind === "share") focusTarget?.select();
    return () => {
      if (element?.open) element.close();
      previousFocus?.focus?.();
    };
  }, [dialog?.id]);

  if (!dialog) return null;
  const titleId = `action-dialog-title-${dialog.id}`;
  const descriptionId = `action-dialog-description-${dialog.id}`;

  async function copyValue() {
    const value = dialog.value || "";
    let success = false;
    try {
      await navigator.clipboard?.writeText(value);
      success = Boolean(navigator.clipboard);
    } catch {}
    if (!success && valueRef.current) {
      valueRef.current.select();
      success = Boolean(document.execCommand?.("copy"));
    }
    setCopied(success);
  }

  return (
    <dialog
      ref={elementRef}
      class={`action-dialog ${dialog.kind === "danger" ? "danger" : ""}`}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!dialog.pending) onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !dialog.pending) onCancel();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <section class="action-dialog-surface">
        <div class="action-dialog-content">
          <div class="action-dialog-icon" aria-hidden="true">
            <Icon name={dialog.kind === "danger" ? "triangle-alert" : "link-2"} />
          </div>
          <div class="action-dialog-copy">
            <span class="action-dialog-eyebrow">{dialog.eyebrow}</span>
            <h2 id={titleId}>{dialog.title}</h2>
            <p id={descriptionId}>{dialog.description}</p>
          </div>
          {dialog.subject ? <code class="action-dialog-subject">{dialog.subject}</code> : null}
          {dialog.kind === "share" ? (
            <label class="action-dialog-value">
              Share URL
              <input ref={valueRef} readonly value={dialog.value || ""} />
            </label>
          ) : null}
          {dialog.error ? (
            <div class="action-dialog-error" role="alert">
              {dialog.error}
            </div>
          ) : null}
        </div>
        <div class="action-dialog-actions">
          {dialog.kind === "share" ? (
            <>
              <button ref={cancelRef} onClick={onCancel}>
                Done
              </button>
              <button class="primary" onClick={() => void copyValue()}>
                <Icon name={copied ? "check" : "copy"} />
                {copied ? "Copied" : "Copy link"}
              </button>
            </>
          ) : (
            <>
              <button ref={cancelRef} disabled={dialog.pending} onClick={onCancel}>
                Cancel
              </button>
              <button
                class="action-dialog-danger"
                disabled={dialog.pending}
                onClick={() => void onConfirm()}
              >
                {dialog.pending ? "Working..." : dialog.confirmLabel}
              </button>
            </>
          )}
        </div>
      </section>
    </dialog>
  );
}

function orderedSessionItems(items, layout) {
  const currentIds = new Set(items.map((item) => item.id));
  if (!layout.manualOrder) return items;
  const order = [
    ...layout.order.filter((id) => currentIds.has(id)),
    ...items.map((item) => item.id).filter((id) => !layout.order.includes(id)),
  ];
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...items].sort(
    (left, right) =>
      (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

function moveSessionLayoutItem(layout, items, sourceId, targetId) {
  const ids = orderedSessionItems(items, layout).map((item) => item.id);
  const sourceIndex = ids.indexOf(sourceId);
  const targetIndex = ids.indexOf(targetId);
  if (sourceIndex === -1 || targetIndex === -1) return layout;
  ids.splice(sourceIndex, 1);
  ids.splice(targetIndex, 0, sourceId);
  return { ...layout, manualOrder: true, order: ids };
}

function defaultSessionLayout(edit = false) {
  return { columns: "auto", edit, manualOrder: false, order: [], sizes: {} };
}

function loadSessionLayout() {
  try {
    return normalizeSessionLayout(
      JSON.parse(localStorage.getItem(sessionLayoutStorageKey) || "null") || defaultSessionLayout(),
    );
  } catch {
    return defaultSessionLayout();
  }
}

function saveSessionLayout(layout) {
  try {
    localStorage.setItem(
      sessionLayoutStorageKey,
      JSON.stringify({
        columns: layout.columns,
        manualOrder: layout.manualOrder,
        order: layout.order,
        sizes: layout.sizes,
      }),
    );
  } catch {}
}

function normalizeSessionLayout(value) {
  return {
    columns: ["auto", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].includes(
      String(value?.columns),
    )
      ? String(value.columns)
      : "auto",
    edit: false,
    manualOrder: Boolean(value?.manualOrder),
    order: Array.isArray(value?.order) ? value.order.map(String).slice(0, 200) : [],
    sizes: typeof value?.sizes === "object" && value.sizes ? value.sizes : {},
  };
}

function parseSessionLink() {
  const match = location.pathname.match(/^\/(?:app\/)?sessions(?:\/([^/]+))?\/?$/);
  return {
    route: Boolean(match),
    id: match?.[1] ? decodeURIComponent(match[1]) : null,
    token: new URLSearchParams(location.search).get("token"),
  };
}

function initialAppView() {
  return location.pathname === "/app/board" || location.pathname === "/app/board/"
    ? "board"
    : "fleet";
}

function isGithubLoginCallback() {
  return new URLSearchParams(location.search).get("login") === "github";
}

function restoreSessionReturnUrl() {
  try {
    const saved = sessionStorage.getItem(loginReturnKey);
    if (!saved || !history.replaceState) return;
    const url = new URL(saved, location.origin);
    const isSessionUrl =
      url.pathname === "/sessions" ||
      url.pathname === "/sessions/" ||
      url.pathname.startsWith("/sessions/") ||
      url.pathname.startsWith("/app/sessions/");
    if (url.origin !== location.origin || !isSessionUrl) return;
    if (location.pathname !== "/app" && location.pathname !== "/app/") return;
    sessionStorage.removeItem(loginReturnKey);
    history.replaceState(null, "", `${url.pathname}${url.search}`);
  } catch {}
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
