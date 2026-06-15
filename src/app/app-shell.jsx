import { defaultDeployment } from "./app-data.js";
import { appShellMetrics, appUserPresentation } from "./app-shell-state.js";
import { BoardPage } from "./board.jsx";
import { appLogo } from "./branding.js";
import { Icon } from "./components.jsx";
import { FleetPage } from "./fleet.jsx";
import { DevIdentityPanel } from "./login.jsx";
import { canOwn } from "./utils.js";

export function AppShell(props) {
  const deployment = props.state.deployment || defaultDeployment;
  const { active, queue, review, cli } = appShellMetrics(props.state);
  const user = props.state.user;
  const { trustedProxyUser, userLabel } = appUserPresentation({
    signedIn: props.signedIn,
    user,
  });
  return (
    <div class="app">
      <aside class="rail" aria-label="Primary">
        <div class="brand-lockup" title={deployment.canonicalUrl}>
          <div class="mark">
            <img src={appLogo} alt="" />
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
            title={trustedProxyUser ? "Signed in by your organization" : undefined}
            disabled={trustedProxyUser}
            onClick={
              trustedProxyUser ? undefined : props.signedIn ? props.logout : props.beginLogin
            }
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
