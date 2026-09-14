export async function startClient({
  window,
  document,
  loadViewer = () => import("./pkg/crabfleet_viewer.js"),
}) {
  const loading = document.getElementById("loading");
  const demo = new URLSearchParams(window.location.search).get("demo") === "1";
  const abort = new AbortController();
  let stage = "gateway";
  let client;
  let retired = false;
  let deadline;
  const release = () => client?.release_input();
  const visibility = () => {
    if (document.hidden) release();
  };
  const retire = () => {
    if (retired) return;
    retired = true;
    abort.abort();
    clearTimeout(deadline);
    window.removeEventListener("blur", release);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pagehide", retire);
    release();
    client?.destroy();
    if (window.crabfleet === client) delete window.crabfleet;
    client = undefined;
  };
  window.addEventListener("blur", release);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pagehide", retire, { once: true });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) window.location.reload();
  });
  try {
    if (!demo) {
      deadline = setTimeout(() => abort.abort(), 5000);
      const response = await window.fetch("/api/health", {
        mode: "same-origin",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: abort.signal,
      });
      if (!response.ok) throw new Error("Gateway unavailable");
      const gateway = await response.json();
      if (gateway.service !== "crabfleet-web-gateway" || gateway.version !== 1)
        throw new Error("Unsupported gateway");
      clearTimeout(deadline);
    }
    if (retired) return;
    stage = "viewer";
    const { default: init, WebHandle } = await loadViewer();
    if (retired) return;
    await init();
    if (retired) return;
    const candidate = new WebHandle();
    client = candidate;
    try {
      await candidate.start(document.getElementById("viewer"), demo);
    } catch (error) {
      candidate.destroy();
      throw error;
    }
    // A renderer may finish initializing after pagehide destroyed its first state.
    if (retired) {
      candidate.destroy();
      return;
    }
    window.crabfleet = candidate;
    if (document.hidden || !document.hasFocus()) release();
    loading.remove();
  } catch {
    if (!retired) {
      retire();
      loading.textContent =
        stage === "gateway"
          ? "The web gateway is unavailable. Start crabfleet-web-gateway and open the address it prints."
          : "The viewer could not start. Check browser GPU support and reload.";
    }
  } finally {
    clearTimeout(deadline);
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  await startClient({ window, document });
}
