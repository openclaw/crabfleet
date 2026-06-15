import { useEffect, useState } from "preact/hooks";
import { normalizeAdminPolicy } from "./admin-state.js";
import { Icon } from "./components.jsx";
import { Drawer } from "./dialogs.jsx";
import { preferredRepo } from "./utils.js";

export function AdminDrawer(props) {
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
        onClick={() => updatePolicy(normalizeAdminPolicy({ cap, retention, merge }))}
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
