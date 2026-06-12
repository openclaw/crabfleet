import { CopyCommand } from "./components.jsx";
import {
  canMaintain,
  elapsed,
  interactiveSessionStatus,
  isTerminalReadyInteractiveSession,
  runCapabilities,
  sessionLogsUrl,
} from "./utils.js";

const productDomain = "crabfleet.openclaw.ai";
const sshHost = "crabd.sh";

export function FleetPage(props) {
  const sessions = props.state.interactiveSessions || [];
  const fleet = props.state.fleet;
  const totals = fleet?.totals || {};
  const fleetSessionsById = new Map(
    (fleet?.sessions || []).map((session) => [session.id, session]),
  );
  const groups = groupedFleetSessions(sessions);
  const ownerCount = groups.length;
  const sessionCount = totals.sessions ?? sessions.length;
  const readyCount = totals.ready ?? countStatuses(sessions, ["ready", "attached", "detached"]);
  const provisioningCount =
    totals.provisioning ?? countStatuses(sessions, ["provisioning", "pending_adapter"]);
  const failedCount = totals.failed ?? countStatuses(sessions, ["failed"]);
  const stoppedCount =
    totals.stopped ?? countStatuses(sessions, ["stopped", "expired", "unavailable"]);

  return (
    <section class="dashboard fleet-dashboard" aria-label="Crabfleet dashboard">
      <section class="fleet-hero">
        <div class="fleet-hero-copy">
          <div class="section-kicker">OPENCLAW / FLEET COMMAND</div>
          <h2>
            <strong>{readyCount}</strong> crabboxes live
          </h2>
          <p>
            One operational view across people, repositories, terminals, WebVNC, and sandbox policy.
          </p>
        </div>
        <div class="fleet-hero-actions">
          <button
            class="primary"
            disabled={!canMaintain(props.state.user)}
            onClick={() => props.openDrawer("interactive")}
          >
            New crabbox
          </button>
          <button onClick={() => props.openSessionGrid(null)}>Open sessions</button>
        </div>
        <div class="fleet-signal-grid" aria-label="Fleet status summary">
          <Signal label="Live" value={readyCount} tone="live" />
          <Signal label="Starting" value={provisioningCount} tone="provisioning" />
          <Signal label="Attention" value={failedCount} tone="failed" />
          <Signal label="People" value={ownerCount} />
          <Signal label="Total" value={sessionCount} />
        </div>
      </section>

      <div class="fleet-ops-grid">
        <ReadinessPanel
          fleet={fleet}
          repos={props.state.repos?.length || 0}
          sessionCount={sessionCount}
          ready={readyCount}
          provisioning={provisioningCount}
          failed={failedCount}
          stopped={stoppedCount}
          board={{
            active: props.active,
            cap: props.state.cap,
            queue: props.queue,
            review: props.review,
          }}
          cli={props.cli}
        />
        <ConnectionDeck
          signedIn={props.signedIn}
          userLabel={props.userLabel}
          beginLogin={props.beginLogin}
        />
      </div>

      <section class="fleet-roster">
        <header class="fleet-roster-head">
          <div>
            <div class="section-kicker">ACTIVE ROSTER</div>
            <h2>Crabboxes by operator</h2>
          </div>
          <span>
            {ownerCount} {ownerCount === 1 ? "operator" : "operators"} / {sessionCount} sessions
          </span>
        </header>
        {groups.length ? (
          <div class="fleet-owner-list">
            {groups.map(([owner, items]) => (
              <section class="fleet-owner" key={owner}>
                <header class="fleet-owner-head">
                  <div class="fleet-owner-lockup">
                    <span class="fleet-owner-mark">{ownerInitial(owner)}</span>
                    <div>
                      <strong>{sessionOwnerLabel(owner)}</strong>
                      <span>
                        {liveFleetCount(items)} live / {items.length} total
                      </span>
                    </div>
                  </div>
                </header>
                <div class="fleet-box-grid">
                  {items.map((session) => (
                    <FleetBox
                      key={session.id}
                      session={{ ...session, fleet: fleetSessionsById.get(session.id) }}
                      openSessionGrid={props.openSessionGrid}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div class="fleet-empty">
            <span class="fleet-empty-index">00</span>
            <div>
              <strong>No crabboxes on the board</strong>
              <p>Create one from SSH, the Go CLI, or the app.</p>
              <CopyCommand value={`ssh ${sshHost} new --repo openclaw/crabfleet`} />
            </div>
            <button
              class="primary"
              onClick={() => props.openDrawer("interactive")}
              disabled={!canMaintain(props.state.user)}
            >
              New crabbox
            </button>
          </div>
        )}
      </section>
    </section>
  );
}

function ReadinessPanel({
  fleet,
  repos,
  sessionCount,
  ready,
  provisioning,
  failed,
  stopped,
  board,
  cli,
}) {
  const egress = fleet?.egress || {};
  const registry = fleet?.registryAvailable === false ? "Registry degraded" : "Registry online";
  const statuses = [
    { label: "Ready", value: ready, tone: "live" },
    { label: "Provisioning", value: provisioning, tone: "provisioning" },
    { label: "Failed", value: failed, tone: "failed" },
    { label: "Stopped", value: stopped, tone: "stopped" },
  ];
  return (
    <section class="readiness-panel" aria-label="Fleet readiness">
      <header class="readiness-head">
        <div>
          <div class="section-kicker">CONTROL PLANE</div>
          <h2>{fleet?.canonicalUrl || `https://${productDomain}`}</h2>
        </div>
        <span class={`registry-state ${fleet?.registryAvailable === false ? "failed" : ""}`}>
          <i aria-hidden="true" />
          {registry}
        </span>
      </header>
      <div class="readiness-bars">
        {statuses.map((status) => (
          <div class="readiness-row" key={status.label}>
            <span>{status.label}</span>
            <div class="readiness-track" aria-hidden="true">
              <i
                class={status.tone}
                style={{ width: `${percentage(status.value, sessionCount)}%` }}
              />
            </div>
            <strong>{status.value}</strong>
          </div>
        ))}
      </div>
      <div class="readiness-meta">
        <span>
          <strong>
            {board.active}/{board.cap}
          </strong>{" "}
          board running
        </span>
        <span>
          <strong>{board.queue}</strong> queued
        </span>
        <span>
          <strong>{board.review}</strong> review
        </span>
        <span>
          <strong>{cli || 0}</strong> attachable
        </span>
        <span>
          <strong>{repos}</strong> repos
        </span>
        <span>
          <strong>{egress.sessionsWithPolicy ?? 0}</strong> policies
        </span>
        <span>
          <strong>{egress.defaultHostCount ?? 0}</strong> default hosts
        </span>
        <a href="/docs/spec-v2">Spec v2</a>
      </div>
    </section>
  );
}

function ConnectionDeck({ signedIn, userLabel, beginLogin }) {
  return (
    <section class="connection-deck" aria-label="Connect to Crabfleet">
      <header>
        <div class="section-kicker">CONNECT</div>
        <h2>Three paths into the fleet</h2>
      </header>
      <div class="connection-step">
        <span class="connection-index">01</span>
        <div>
          <strong>GitHub identity</strong>
          <p>{signedIn ? userLabel : "Scope repositories, pull requests, and gh credentials."}</p>
        </div>
        <button onClick={beginLogin} disabled={signedIn}>
          {signedIn ? "Connected" : "Connect"}
        </button>
      </div>
      <div class="connection-step">
        <span class="connection-index">02</span>
        <div>
          <strong>Link SSH</strong>
          <p>Attach a public key once for terminal-first control.</p>
        </div>
        <CopyCommand value={`ssh link@${sshHost}`} />
      </div>
      <div class="connection-step">
        <span class="connection-index">03</span>
        <div>
          <strong>Launch work</strong>
          <p>Start with a prepared repo and Codex ready.</p>
        </div>
        <CopyCommand
          value={`ssh ${sshHost} new --repo openclaw/crabfleet "fix the failing check"`}
        />
      </div>
    </section>
  );
}

function FleetBox({ session, openSessionGrid }) {
  const capabilities = runCapabilities(session);
  const archiveCount = session.logArchive?.eventCount || session.logs?.length || 0;
  const fleetPolicy = session.fleet?.policy;
  const status = interactiveSessionStatus(session);
  const seen = session.lastSeenAt || session.updatedAt || session.createdAt;
  return (
    <article class={`fleet-box ${status.tone || "idle"}`}>
      <header class="fleet-box-head">
        <div>
          <span class="fleet-box-id">{session.id}</span>
          <strong>{session.repo || session.title || session.id}</strong>
        </div>
        <span class={`state-pill ${status.tone || "idle"}`}>{status.label}</span>
      </header>
      <div class="fleet-box-meta">
        <span>{session.branch || "main"}</span>
        <span>{session.runtime || "crabbox"}</span>
        {capabilities.vnc ? <span>webvnc</span> : null}
        {archiveCount ? <span>{archiveCount} logs</span> : null}
        {fleetPolicy?.present ? <span>{fleetPolicy.allowedHostCount} egress</span> : null}
      </div>
      <p class="fleet-box-event">{session.lastEvent || "Waiting for crabbox"}</p>
      <div class="fleet-box-command">
        <code>
          ssh {sshHost} attach {session.id}
        </code>
        <span>{seen ? `seen ${elapsed(seen)}` : "no heartbeat"}</span>
      </div>
      <div class="fleet-box-actions">
        <button class="primary" onClick={() => openSessionGrid(session.id)}>
          Terminal
        </button>
        {session.vncUrl ? (
          <button onClick={() => window.open(session.vncUrl, "_blank", "noopener")}>VNC</button>
        ) : capabilities.vnc ? (
          <button
            class="pending-vnc"
            disabled
            title="WebVNC URL appears after crabbox provisioning"
          >
            VNC pending
          </button>
        ) : null}
        {!session.sharedReadOnly ? (
          <button onClick={() => window.open(sessionLogsUrl(session.id), "_blank", "noopener")}>
            Logs
          </button>
        ) : null}
      </div>
    </article>
  );
}

function Signal({ label, value, tone = "" }) {
  return (
    <div class={`fleet-signal ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function sessionOwner(session) {
  return session.owner || session.operator || "unassigned";
}

function sessionOwnerLabel(owner) {
  return String(owner || "unassigned").replace(/^github:/, "@");
}

function ownerInitial(owner) {
  return sessionOwnerLabel(owner).replace(/^@/, "").slice(0, 1).toUpperCase() || "?";
}

function groupedFleetSessions(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const owner = sessionOwner(session);
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(session);
  }
  return [...groups.entries()]
    .map(([owner, items]) => [
      owner,
      [...items].sort(
        (a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0),
      ),
    ])
    .sort((a, b) => {
      const activeDelta = liveFleetCount(b[1]) - liveFleetCount(a[1]);
      return activeDelta || sessionOwnerLabel(a[0]).localeCompare(sessionOwnerLabel(b[0]));
    });
}

function liveFleetCount(sessions) {
  return sessions.filter(isTerminalReadyInteractiveSession).length;
}

function countStatuses(sessions, statuses) {
  const allowed = new Set(statuses);
  return sessions.filter((session) => allowed.has(session.status)).length;
}

function percentage(value, total) {
  if (!total || value <= 0) return 0;
  return Math.max(2, Math.round((value / total) * 100));
}
