import { useEffect, useState } from "preact/hooks";
import { Drawer } from "./dialogs.jsx";
import {
  canMaintain,
  hasRunCapability,
  isActiveRun,
  preferredRepo,
  preferredRepos,
  runtimeProfileOptionLabel,
} from "./utils.js";
import { interactiveCreationDefaults, runCapabilitySummary } from "./work-drawer-state.js";

export function CardDrawer({ drawers, closeDrawer, createCard, state }) {
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

export function InteractiveDrawer({ drawers, closeDrawer, createInteractiveSession, state }) {
  const defaults = interactiveCreationDefaults(state.deployment);
  const [busy, setBusy] = useState(false);
  const [runtime, setRuntime] = useState(defaults.runtime);
  useEffect(() => setRuntime(defaults.runtime), [defaults.runtime]);
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
        onReset={() => setRuntime(defaults.runtime)}
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
        {defaults.runtimes.length > 1 ? (
          <label>
            Runtime
            <select
              name="runtime"
              value={runtime}
              onChange={(event) => setRuntime(event.currentTarget.value)}
            >
              {defaults.runtimes.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <input type="hidden" name="runtime" value={runtime} />
        )}
        {runtime === "crabbox" && defaults.profiles.length > 0 ? (
          <label>
            Profile
            <select key={defaults.profile} name="profile" defaultValue={defaults.profile}>
              {defaults.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {runtimeProfileOptionLabel(profile)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <input type="hidden" name="profile" value={defaults.profile} />
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

export function RunDrawer({ drawers, closeDrawer, activeRunId, state, cardAction }) {
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
  const { capabilities, label } = runCapabilitySummary(card);
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
          Capabilities <strong>{label}</strong>
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
