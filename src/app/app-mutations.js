import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { canCleanInteractiveSession } from "./session-state.js";
import { disposeTerminal } from "./terminal.js";
import {
  canDeleteInteractiveWorkspace,
  issueNumber,
  optimisticInteractiveSession,
  titleFromPrompt,
} from "./utils.js";

const emptyRefPreview = {
  number: "",
  loading: false,
  matches: [],
  error: "",
};

export function replaceCardState(state, card) {
  return {
    ...state,
    cards: state.cards.map((item) => (item.id === card.id ? card : item)),
  };
}

export function upsertInteractiveSessionState(state, session) {
  const sessions = state.interactiveSessions || [];
  return {
    ...state,
    interactiveSessions: sessions.some((item) => item.id === session.id)
      ? sessions.map((item) => (item.id === session.id ? session : item))
      : [session, ...sessions],
  };
}

export function removeInteractiveSessionState(state, id) {
  return {
    ...state,
    interactiveSessions: (state.interactiveSessions || []).filter((session) => session.id !== id),
  };
}

export function interactiveStopDialog(session, id) {
  const label = session ? `${session.repo} (${session.id})` : id;
  const deletesWorkspace = canDeleteInteractiveWorkspace(session);
  const endsWorkflowSession = session?.runtime === "github_actions";
  return {
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
        : "This stops Crabfleet access and releases the managed Sandbox resources. Final status and logs stay visible in Crabfleet.",
    subject: label,
    confirmLabel: deletesWorkspace
      ? "Delete workspace"
      : endsWorkflowSession
        ? "End session"
        : "Stop session",
  };
}

export function interactiveShareDialog(shareUrl) {
  return {
    kind: "share",
    eyebrow: "Read-only access",
    title: "Share link ready",
    description: "Copy this read-only link to share the session.",
    value: shareUrl,
  };
}

export async function presentInteractiveShareLink(id, interactiveSessionAction, openActionDialog) {
  const result = await interactiveSessionAction(id, "share_link");
  if (result.shareUrl) openActionDialog(interactiveShareDialog(result.shareUrl));
  return result;
}

export function useAppMutations({
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
}) {
  const [search, setSearchState] = useState("");
  const [refPreview, setRefPreview] = useState(emptyRefPreview);
  const refPreviewTimer = useRef(null);
  const refPreviewSeq = useRef(0);

  useEffect(
    () => () => {
      if (refPreviewTimer.current) clearTimeout(refPreviewTimer.current);
    },
    [],
  );

  function findCard(id) {
    return stateRef.current.cards.find((card) => card.id === id);
  }

  function findInteractiveSession(id) {
    return (stateRef.current.interactiveSessions || []).find((session) => session.id === id);
  }

  function upsertCard(card) {
    setState((current) => replaceCardState(current, card));
  }

  function upsertInteractiveSession(session) {
    setState((current) => upsertInteractiveSessionState(current, session));
  }

  function removeInteractiveSession(id) {
    setState((current) => removeInteractiveSessionState(current, id));
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
    openActionDialog({
      ...interactiveStopDialog(session, id),
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
    return presentInteractiveShareLink(id, interactiveSessionAction, openActionDialog);
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

  function setSearch(value) {
    setSearchState(value);
    scheduleRefPreview(value);
  }

  function scheduleRefPreview(value) {
    const number = issueNumber(value);
    refPreviewSeq.current += 1;
    if (refPreviewTimer.current) clearTimeout(refPreviewTimer.current);
    if (!number) {
      setRefPreview(emptyRefPreview);
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
    setRefPreview(emptyRefPreview);
    setSearchState("");
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

  return {
    search,
    setSearch,
    refPreview,
    findInteractiveSession,
    upsertInteractiveSession,
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
}
