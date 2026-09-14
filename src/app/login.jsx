import { useEffect, useState } from "preact/hooks";
import { defaultDeployment } from "./app-data.js";
import { appLogo } from "./branding.js";
import { CopyCommand, Icon } from "./components.jsx";
import { developmentIdentityDefaults } from "./login-state.js";

const devIdentityPresets = [
  { id: "admin-1", name: "Admin 1", role: "owner" },
  { id: "admin-2", name: "Admin 2", role: "owner" },
  { id: "user-1", name: "User 1", role: "maintainer" },
  { id: "user-2", name: "User 2", role: "viewer" },
];

export function LoginScreen({
  hidden,
  authMethods,
  deployment = defaultDeployment,
  message,
  onGithub,
  onToken,
  onDevIdentity,
}) {
  const [token, setToken] = useState("");
  const [submittingToken, setSubmittingToken] = useState(false);
  return (
    <section class="login-screen" hidden={hidden}>
      <header class="login-header">
        <a class="login-wordmark" href={deployment.productUrl || "/docs/"}>
          <img src={appLogo} alt="" width="32" height="32" />
          <span>{deployment.label}</span>
        </a>
        <a class="login-back" href="/docs/">
          Documentation <span aria-hidden="true">↗</span>
        </a>
      </header>
      <div class="login-story">
        <div class="section-kicker">A HOME FOR YOUR AGENT WORK</div>
        <h2>
          Your fleet.
          <br />
          <em>Within reach.</em>
        </h2>
        <p>
          One place for your workspaces, live terminals, and shared desktops. Pick up wherever your
          work takes you.
        </p>
        <div class="login-map" aria-hidden="true">
          <div class="login-map-head">
            <span>CRABFLEET / CONNECTED WORK</span>
            <span>↗</span>
          </div>
          <div>
            <Icon name="square-terminal" />
            <span>Repo-ready workspaces</span>
            <i />
          </div>
          <div>
            <Icon name="terminal" />
            <span>Live terminal sessions</span>
            <i />
          </div>
          <div>
            <Icon name="layout-grid" />
            <span>Shared desktops</span>
            <i />
          </div>
          <div class="login-map-foot">SSH · BROWSER · NATIVE</div>
        </div>
        <span class="login-story-note">Your tools. Your work. One clear view.</span>
      </div>
      <form
        class="login-panel"
        aria-busy={submittingToken}
        onSubmit={async (event) => {
          event.preventDefault();
          const submittedToken = token;
          setSubmittingToken(true);
          try {
            if ((await onToken(submittedToken)) !== false) setToken("");
          } finally {
            setSubmittingToken(false);
          }
        }}
      >
        <div class="login-brand">
          <span class="section-kicker">YOUR WORKSPACE AWAITS</span>
          <h1>Welcome aboard.</h1>
          <p>Sign in to {deployment.label} to connect to your fleet.</p>
        </div>
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
            <span>Prefer the terminal?</span>
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
              <input
                type="text"
                name="username"
                autocomplete="username"
                value="bootstrap-token"
                hidden
                readOnly
              />
              <label>
                Bootstrap token
                <input
                  type="password"
                  name="bootstrap-token"
                  autocomplete="current-password"
                  autocapitalize="none"
                  autocorrect="off"
                  spellcheck={false}
                  enterkeyhint="go"
                  disabled={!authMethods.token || submittingToken}
                  value={token}
                  onInput={(event) => setToken(event.currentTarget.value)}
                />
              </label>
              <button type="submit" disabled={!authMethods.token || submittingToken}>
                {submittingToken ? "Signing in…" : "Use token"}
              </button>
            </div>
          </details>
        </div>
        <DevIdentityPanel
          hidden={!authMethods.devIdentity}
          user={null}
          onDevIdentity={onDevIdentity}
        />
        <div class={`banner ${message ? "show" : ""}`} role="status" aria-live="polite">
          {message}
        </div>
        <div class="login-footer">
          <span>Access is managed by your organization.</span>
        </div>
      </form>
    </section>
  );
}

export function DevIdentityPanel({ hidden, user, onDevIdentity }) {
  const defaults = developmentIdentityDefaults(user);
  const [id, setId] = useState(defaults.id);
  const [name, setName] = useState(defaults.name);
  const [role, setRole] = useState(defaults.role);

  useEffect(() => {
    if (hidden) return;
    setId(defaults.id);
    setName(defaults.name);
    setRole(defaults.role);
  }, [hidden, defaults.id, defaults.name, defaults.role]);

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
