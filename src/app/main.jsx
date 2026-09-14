import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { DesktopViewer, desktopViewerHostID } from "./desktop-viewer.jsx";
import "./style.css";
import "./desktop-viewer.css";

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(value.error || "Request failed"), { status: response.status });
  return value;
}

function App() {
  const [user, setUser] = useState(null);
  const [auth, setAuth] = useState({});
  const [hosts, setHosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [path, setPath] = useState(location.pathname);
  const [query, setQuery] = useState("");
  const [allow, setAllow] = useState(null);

  useEffect(() => {
    let disposed = false;
    Promise.all([
      api("/api/auth"),
      api("/api/session").catch((failure) => {
        if (failure.status !== 401 && failure.status !== 403) throw failure;
        if (failure.status === 403 && !disposed) setError(failure.message);
        return { user: null };
      }),
    ])
      .then(([configuration, session]) => {
        if (disposed) return;
        setAuth(configuration.auth);
        setUser(session.user);
      })
      .catch((failure) => {
        if (!disposed) setError(failure.message);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    const pop = () => setPath(location.pathname);
    window.addEventListener("popstate", pop);
    return () => {
      disposed = true;
      window.removeEventListener("popstate", pop);
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    let disposed = false;
    let timer;
    const refresh = async () => {
      try {
        const value = await api("/api/fleet");
        if (!disposed) {
          setHosts(value.fleet.desktopHosts);
          setError("");
        }
      } catch (failure) {
        if (!disposed) {
          setError(failure.message);
          if (failure.status === 401 || failure.status === 403) {
            setHosts([]);
            setUser(null);
            setAllow(null);
          }
        }
      } finally {
        if (!disposed) timer = setTimeout(refresh, 15000);
      }
    };
    refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [user]);

  function navigate(next) {
    history.pushState(null, "", next);
    setPath(next);
  }
  async function perform(action) {
    setPending(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setPending(false);
    }
  }
  const hostID = desktopViewerHostID(path);
  const selectedHost = hosts.find((host) => host.id === hostID);
  if (user && selectedHost)
    return <DesktopViewer host={selectedHost} onExit={() => navigate("/app/")} />;
  const visibleHosts = hosts.filter((host) =>
    `${host.name} ${host.owner}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <main class="shell">
      <header class="masthead">
        <a class="wordmark" href="/app/">
          <img src="/crabbox-logo.png" alt="" />
          Crabfleet
        </a>
        <nav aria-label="Account">
          <a href="https://docs.crabfleet.ai/">Guide</a>
          {user && (
            <>
              <span>{user.name || user.login || user.email}</span>
              <button
                disabled={pending}
                onClick={() =>
                  perform(async () => {
                    await api("/api/logout", { method: "POST" });
                    setUser(null);
                    setHosts([]);
                    setAllow(null);
                  })
                }
              >
                Sign out
              </button>
            </>
          )}
        </nav>
      </header>
      <section class="intro">
        <p class="eyebrow">REMOTE DESKTOP</p>
        <h1>
          Your computers,
          <br />
          <em>within reach.</em>
        </h1>
        <p>
          Connect with Crabfleet for Mac. Share a desktop, save your VNC connections, and pick up
          where you left off.
        </p>
      </section>
      {error && (
        <p role="alert" class="notice">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">Loading your desktops…</p>
      ) : !user ? (
        <section class="login-panel">
          <h2>Access your desktops</h2>
          <p>Sign in to discover your shared computers and connect from this browser.</p>
          {auth.github && (
            <a class="button primary" href="/login/github">
              Continue with GitHub
            </a>
          )}
          {auth.token && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const token = new FormData(form).get("token");
                perform(async () => {
                  const result = await api("/api/login/token", {
                    method: "POST",
                    body: JSON.stringify({ token }),
                  });
                  form.reset();
                  setUser(result.user);
                });
              }}
            >
              <label>
                Owner recovery token
                <input type="password" name="token" required autoComplete="off" />
              </label>
              <button disabled={pending}>Sign in</button>
            </form>
          )}
          {auth.devIdentity && (
            <button
              disabled={pending}
              onClick={() =>
                perform(async () => {
                  const result = await api("/api/login/dev", {
                    method: "POST",
                    body: JSON.stringify({ id: "desktop-dev" }),
                  });
                  setUser(result.user);
                })
              }
            >
              Local development sign-in
            </button>
          )}
          {!auth.github && !auth.token && !auth.devIdentity && (
            <p>Use your deployment’s sign-in gateway to continue.</p>
          )}
          <p class="muted">Saved VNC connections in the Mac app work without an account.</p>
        </section>
      ) : (
        <section aria-label="Your desktops">
          <div class="section-heading">
            <h2>
              Your desktops <span>{hosts.length}</span>
            </h2>
            <input
              aria-label="Search desktops"
              type="search"
              placeholder="Find a computer"
              value={query}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          {hostID && !selectedHost && (
            <p role="status">
              This desktop is unavailable.{" "}
              <button onClick={() => navigate("/app/")}>Back to desktops</button>
            </p>
          )}
          {hosts.length === 0 ? (
            <div class="empty">
              <h3>Your next connection starts here.</h3>
              <p>
                Choose “Share This Mac” in Crabfleet, or sign in with Crabfleet Connect on Linux.
                Shared desktops will appear here.
              </p>
              <a href="https://docs.crabfleet.ai/quickstart/">Set up desktop sharing →</a>
            </div>
          ) : (
            <div class="desktop-grid">
              {visibleHosts.map((host) => (
                <article class="computer" key={host.id}>
                  <div class="monitor" aria-hidden="true">
                    <span>{host.name.slice(0, 1).toUpperCase()}</span>
                  </div>
                  <div class="computer-details">
                    <h3>{host.name}</h3>
                    <p>{host.owner}</p>
                  </div>
                  {host.relayCapable ? (
                    <button
                      class="primary"
                      onClick={() => navigate(`/app/desktops/${encodeURIComponent(host.id)}`)}
                    >
                      Connect
                    </button>
                  ) : (
                    <span class="muted">Connect with the Mac app</span>
                  )}
                </article>
              ))}
            </div>
          )}
          {hosts.length > 0 && visibleHosts.length === 0 && <p>No desktops match your search.</p>}
          {user.role === "owner" && (
            <section class="access">
              <button
                disabled={pending}
                onClick={() =>
                  perform(async () =>
                    setAllow(allow ? null : (await api("/api/admin/allow")).allow),
                  )
                }
              >
                {allow ? "Close access settings" : "Manage access"}
              </button>
              {allow && (
                <>
                  <h3>Who can sign in</h3>
                  <p>Allowing sign-in keeps each person’s desktops private to their account.</p>
                  <ul>
                    {allow.map((entry) => (
                      <li key={entry.value}>
                        <span>
                          {entry.value} · {entry.role}
                        </span>
                        <button
                          disabled={pending}
                          onClick={() =>
                            perform(async () =>
                              setAllow(
                                (
                                  await api(`/api/admin/allow/${encodeURIComponent(entry.value)}`, {
                                    method: "DELETE",
                                  })
                                ).allow,
                              ),
                            )
                          }
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = event.currentTarget;
                      const value = new FormData(form).get("value");
                      perform(async () => {
                        setAllow(
                          (
                            await api("/api/admin/allow", {
                              method: "POST",
                              body: JSON.stringify({ value, role: "viewer" }),
                            })
                          ).allow,
                        );
                        form.reset();
                      });
                    }}
                  >
                    <label>
                      GitHub user, team, or email
                      <input name="value" required placeholder="@username" />
                    </label>
                    <button disabled={pending}>Allow sign-in</button>
                  </form>
                </>
              )}
            </section>
          )}
        </section>
      )}
      <footer>
        Crabfleet <span>Native VNC. Private desktop sharing.</span>
      </footer>
    </main>
  );
}

render(<App />, document.getElementById("app"));
