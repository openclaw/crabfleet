export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export async function api(path, options = {}) {
  const init = {
    method: options.method || "GET",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal: options.signal ?? AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
  };
  if (options.body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, init);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(
      response.status === 401 ? "unauthorized" : body.error || response.statusText,
    );
    error.status = response.status;
    throw error;
  }
  return body;
}
