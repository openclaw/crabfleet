import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./components.jsx";
import {
  defaultSessionLayout,
  moveSessionLayoutItem,
  orderedSessionItems,
} from "./session-layout.js";
import {
  canCleanInteractiveSession,
  isLocalInteractiveSession,
  isSessionGridItem,
  sessionFooterSummary,
  sessionStatus,
  sessionTerminalStatusLabel,
  terminalMountKey,
  terminalProvisioningDetail,
} from "./session-state.js";
import { disposeMissingTerminals, disposeTerminal, mountTerminal } from "./terminal.js";
import {
  canDeleteInteractiveWorkspace,
  canMaintain,
  hasRunCapability,
  humanStatus,
  isDeadInteractiveSession,
  isProvisioningInteractiveSession,
  sessionLogsUrl,
  terminalText,
} from "./utils.js";

export function SessionsDrawer(props) {
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
          {editable ? <SessionLayoutButtons /> : null}
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
    return <button onClick={() => props.openRunDetails(session.id)}>Details</button>;
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
  if (isLocalInteractiveSession(session)) return null;
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

function SessionStatus({ session }) {
  const status = sessionStatus(session);
  return <span class={`session-status ${status.tone}`}>{status.label}</span>;
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
