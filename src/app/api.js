export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
    headers: { "content-type": "application/json", ...options.headers },
  });
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(value.error || "Request failed"), { status: response.status });
  return value;
}
