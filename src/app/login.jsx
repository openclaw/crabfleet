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
      <a class="login-back" href="/docs/">
        &larr; documentation
      </a>
      <InfrastructureField />
      <form
        class="login-panel"
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
          <div class="mark">
            <img src={appLogo} alt="" />
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
                  disabled={!authMethods.token || submittingToken}
                  value={token}
                  onInput={(event) => setToken(event.currentTarget.value)}
                />
              </label>
              <button type="submit" disabled={!authMethods.token || submittingToken}>
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
