import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { isGithubLoginCallback, loginReturnKey } from "./routing.js";
import { linkedInteractiveSessionPlaceholder, preferredRepo } from "./utils.js";

export const defaultDeployment = {
  label: "Crabfleet",
  canonicalUrl: "https://crabfleet.openclaw.ai",
  productUrl: "https://crabfleet.ai",
  sshHost: "crabd.sh",
  preferredRepo,
  defaultRuntime: "container",
  defaultProfile: "default",
  runtimeProfiles: [],
};

export const defaultAuthMethods = {
  github: false,
  token: false,
  devIdentity: false,
  trustedProxy: false,
};

export const emptyState = {
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

const skipAutoGithubLoginKey = "crabbox-skip-auto-github-login";
const githubAutoLoginReadyKey = "crabbox-github-auto-login-ready";

export function initialAppState(initialSessionLink) {
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

export function retainLinkedSession(nextState, linkedSession) {
  if (
    !linkedSession ||
    (nextState.interactiveSessions || []).some((session) => session.id === linkedSession.id)
  ) {
    return nextState;
  }
  return {
    ...nextState,
    interactiveSessions: [linkedSession, ...(nextState.interactiveSessions || [])],
  };
}

export function sharedSessionState(session, auth, deployment = defaultDeployment) {
  return {
    user: { subject: "shared", login: "shared link", role: "viewer" },
    auth,
    org: "OpenClaw",
    cap: 20,
    retention: "30",
    merge: "guarded",
    allow: [],
    repos: [session.repo],
    workflows: [],
    cards: [],
    interactiveSessions: [session],
    deployment,
  };
}

export function shouldAutoGithubLogin({
  signedIn,
  started,
  methods,
  shared,
  tokenBypass,
  skipped,
  ready,
}) {
  if (signedIn || started || !methods?.github || methods.devIdentity) return false;
  if (methods.token && tokenBypass) return false;
  if (shared?.id && shared?.token) return false;
  return !skipped && ready;
}

export function createAppPolling({
  runInitial,
  runInterval,
  runRetry = runInitial,
  timers = globalThis,
  pollIntervalMs = 15000,
  retryDelayMs = 5000,
}) {
  let intervalId = null;
  let retryId = null;

  return {
    start() {
      if (intervalId !== null) return;
      void runInitial();
      intervalId = timers.setInterval(() => void runInterval(), pollIntervalMs);
    },
    scheduleRetry() {
      if (retryId !== null) return;
      retryId = timers.setTimeout(() => {
        retryId = null;
        void runRetry();
      }, retryDelayMs);
    },
    clearRetry() {
      if (retryId === null) return;
      timers.clearTimeout(retryId);
      retryId = null;
    },
    stop() {
      if (intervalId !== null) timers.clearInterval(intervalId);
      intervalId = null;
      if (retryId !== null) timers.clearTimeout(retryId);
      retryId = null;
    },
  };
}

export function createRequestFence() {
  let generation = 0;
  return {
    next() {
      generation += 1;
      return generation;
    },
    isCurrent(candidate) {
      return candidate === generation;
    },
  };
}

export function useAppData({
  initialSessionLink,
  activeRunId,
  runDrawerOpen,
  sharedSessionId,
  sharedToken,
  onSignedOut,
  onSharedSessionLoaded,
  onSharedSessionRejected,
}) {
  const [state, setState] = useState(() => initialAppState(initialSessionLink));
  const [signedIn, setSignedIn] = useState(false);
  const [authMethods, setAuthMethods] = useState(defaultAuthMethods);
  const [loginMessage, setLoginMessage] = useState("");
  const stateRef = useRef(state);
  const signedInRef = useRef(signedIn);
  const authMethodsRef = useRef(authMethods);
  const activeRunRef = useRef({ id: activeRunId, open: runDrawerOpen });
  const sharedRef = useRef({ id: sharedSessionId, token: sharedToken });
  const callbacksRef = useRef({
    onSignedOut,
    onSharedSessionLoaded,
    onSharedSessionRejected,
  });
  const mountedRef = useRef(false);
  const autoLoginStarted = useRef(false);
  const githubLoginCallback = useRef(isGithubLoginCallback());
  const stateRequestRef = useRef(null);
  const stateRequestFence = useRef(createRequestFence());
  const sharedRequestRef = useRef(null);
  const loadStateRef = useRef(null);
  const loadSharedSessionRef = useRef(null);
  const pollingRef = useRef(null);

  stateRef.current = state;
  signedInRef.current = signedIn;
  authMethodsRef.current = authMethods;
  activeRunRef.current = { id: activeRunId, open: runDrawerOpen };
  sharedRef.current = { id: sharedSessionId, token: sharedToken };
  callbacksRef.current = {
    onSignedOut,
    onSharedSessionLoaded,
    onSharedSessionRejected,
  };

  if (!pollingRef.current) {
    pollingRef.current = createAppPolling({
      runInitial: () => loadStateRef.current?.(),
      runInterval: () => {
        if (signedInRef.current) return loadStateRef.current?.();
        const shared = sharedRef.current;
        if (!shared.id || !shared.token || document.body.classList.contains("locked")) return;
        return loadSharedSessionRef.current?.().catch((error) => {
          if (error.status === 403 || error.status === 404) {
            return showSharedLinkError(error);
          }
          console.warn("Shared session refresh failed", error);
        });
      },
      runRetry: () => loadStateRef.current?.(),
    });
  }

  useEffect(() => {
    mountedRef.current = true;
    pollingRef.current.start();
    return () => {
      mountedRef.current = false;
      pollingRef.current.stop();
    };
  }, []);

  useEffect(() => {
    if (!signedIn && !loginMessage) void maybeAutoGithubLogin(authMethods);
  }, [signedIn, loginMessage, authMethods, sharedSessionId, sharedToken]);

  async function performLoadState(generation) {
    try {
      let nextState = await api("/api/state", { authOptional: true });
      if (!isCurrentStateRequest(generation)) return;
      const linkedSessionId = sharedRef.current.id;
      const linkedSession = linkedSessionId
        ? (stateRef.current.interactiveSessions || []).find(
            (session) => session.id === linkedSessionId,
          )
        : null;
      nextState = retainLinkedSession(nextState, linkedSession);
      const activeRun = activeRunRef.current;
      const activeCard = nextState.cards.find((card) => card.id === activeRun.id);
      if (activeRun.id && activeRun.open && activeCard?.changes?.files?.length) {
        const result = await api(`/api/cards/${encodeURIComponent(activeRun.id)}/actions`, {
          method: "POST",
          body: { action: "attach" },
        });
        if (!isCurrentStateRequest(generation)) return;
        nextState.cards = nextState.cards.map((card) =>
          card.id === result.card.id ? result.card : card,
        );
      }
      pollingRef.current.clearRetry();
      setAuthMethods(nextState.auth || authMethodsRef.current);
      setState(nextState);
      setSignedIn(true);
      setLoginMessage("");
      finishGithubLoginCallback(true);
    } catch (error) {
      if (!isCurrentStateRequest(generation)) return;
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
        if (!isCurrentStateRequest(generation)) return;
        finishGithubLoginCallback(false);
        if (error.status === 401 && (await maybeAutoGithubLogin(methods))) return;
        callbacksRef.current.onSignedOut?.();
        setSignedIn(false);
        setLoginMessage(error.message === "unauthorized" ? "" : error.message);
        return;
      }
      setLoginMessage(error.message);
      pollingRef.current.scheduleRetry();
    }
  }

  function loadState({ fresh = false } = {}) {
    if (!fresh && stateRequestRef.current) return stateRequestRef.current.request;
    const generation = stateRequestFence.current.next();
    const request = performLoadState(generation).finally(() => {
      if (stateRequestRef.current?.request === request) stateRequestRef.current = null;
    });
    stateRequestRef.current = { generation, request };
    return request;
  }

  function refreshState() {
    return loadState({ fresh: true });
  }

  function isCurrentStateRequest(generation) {
    return mountedRef.current && stateRequestFence.current.isCurrent(generation);
  }

  async function performLoadSharedSession(shared) {
    let result;
    try {
      result = await api(
        `/api/shared-sessions/${encodeURIComponent(shared.id)}?token=${encodeURIComponent(shared.token)}`,
        { authOptional: true },
      );
    } catch (error) {
      if (!sameSharedLink(sharedRef.current, shared)) return null;
      throw error;
    }
    if (!sameSharedLink(sharedRef.current, shared)) return null;
    const methods = await loadAuthMethods();
    if (!mountedRef.current || !sameSharedLink(sharedRef.current, shared)) return null;
    setState(
      sharedSessionState(result.session, methods, stateRef.current.deployment || defaultDeployment),
    );
    setSignedIn(false);
    callbacksRef.current.onSharedSessionLoaded?.(result.session);
    return result.session;
  }

  function loadSharedSession() {
    const shared = { ...sharedRef.current };
    const key = sharedLinkKey(shared);
    if (sharedRequestRef.current?.key === key) return sharedRequestRef.current.request;
    const request = performLoadSharedSession(shared).finally(() => {
      if (sharedRequestRef.current?.request === request) sharedRequestRef.current = null;
    });
    sharedRequestRef.current = { key, request };
    return request;
  }

  async function showSharedLinkError(error) {
    await loadAuthMethods();
    if (!mountedRef.current) return;
    callbacksRef.current.onSharedSessionRejected?.();
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
      if (!mountedRef.current) return methods;
      if (result.deployment) {
        setState((current) => ({ ...current, deployment: result.deployment }));
      }
      setAuthMethods(methods);
      return methods;
    } catch {
      const methods = { github: false, token: true, devIdentity: false, trustedProxy: false };
      if (mountedRef.current) setAuthMethods(methods);
      return methods;
    }
  }

  async function beginLogin() {
    try {
      sessionStorage.removeItem(skipAutoGithubLoginKey);
    } catch {}
    preserveLoginReturnUrl();
    let methods = authMethodsRef.current;
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
      await refreshState();
    } catch (error) {
      if (mountedRef.current) setLoginMessage(String(error.message || error));
    }
  }

  async function devIdentityLogin(identity) {
    try {
      await api("/api/login/dev", {
        method: "POST",
        body: identity,
        authOptional: true,
      });
      await refreshState();
    } catch (error) {
      if (mountedRef.current) setLoginMessage(String(error.message || error));
    }
  }

  async function logout() {
    try {
      sessionStorage.setItem(skipAutoGithubLoginKey, "1");
      localStorage.removeItem(githubAutoLoginReadyKey);
    } catch {}
    autoLoginStarted.current = false;
    await api("/api/logout", { method: "POST", authOptional: true });
    await refreshState();
  }

  async function maybeAutoGithubLogin(methods = authMethodsRef.current) {
    let skipped;
    let ready;
    try {
      skipped = sessionStorage.getItem(skipAutoGithubLoginKey) === "1";
      ready = localStorage.getItem(githubAutoLoginReadyKey) === "1";
    } catch {
      return false;
    }
    const shouldStart = shouldAutoGithubLogin({
      signedIn: signedInRef.current,
      started: autoLoginStarted.current,
      methods,
      shared: sharedRef.current,
      tokenBypass: new URLSearchParams(location.search).get("auth") === "token",
      skipped,
      ready,
    });
    if (!shouldStart) return false;
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

  loadStateRef.current = loadState;
  loadSharedSessionRef.current = loadSharedSession;

  return {
    state,
    setState,
    stateRef,
    signedIn,
    authMethods,
    loginMessage,
    setLoginMessage,
    loadState,
    refreshState,
    loadSharedSession,
    beginLogin,
    tokenLogin,
    devIdentityLogin,
    logout,
  };
}

function sharedLinkKey(shared) {
  return `${shared.id || ""}\0${shared.token || ""}`;
}

export function sameSharedLink(current, expected) {
  return sharedLinkKey(current) === sharedLinkKey(expected);
}
