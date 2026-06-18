import { visibleBoardCards } from "./board-state.js";
import { canMaintain, canOwn, elapsed, lanes, statusLabel } from "./utils.js";

export function BoardPage(props) {
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
  const cards = visibleBoardCards(props.state.cards, {
    filter: props.filter,
    current,
    query: props.search,
  });
  return (
    <section class="board" aria-label="Crabfleet board">
      {lanes.map((lane) => {
        const laneCards = cards.filter((card) => card.lane === lane);
        return (
          <section class="lane" key={lane}>
            <div class="lane-head">
              <span>{lane}</span>
              <small>{laneCards.length}</small>
            </div>
            <div class="cards">
              {laneCards.length ? (
                laneCards.map((card) => <Card key={card.id} card={card} {...props} />)
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
