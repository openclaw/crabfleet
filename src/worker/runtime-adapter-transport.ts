import { readBoundedResponseText } from "../bounded-response.ts";
import {
  runtimeAdapterControlPlaneIdentity,
  runtimeAdapterName,
  safeDesktopUrl,
} from "../runtime-adapter.ts";
import type { RuntimeEnv } from "./env.ts";
import { runtimeAdapterToken } from "./runtime-adapter-preflight.ts";

type FetchTarget = Fetcher | typeof globalThis;

export async function runtimeAdapterFetch(
  env: RuntimeEnv,
  url: string,
  init: RequestInit,
  fallbackFetcher: FetchTarget = globalThis,
): Promise<Response> {
  const token = runtimeAdapterToken(env);
  if (!token) throw new Error("runtime adapter token is not configured");
  const safeTarget = safeDesktopUrl(url);
  if (!safeTarget) throw new Error("runtime adapter URL must use HTTPS or loopback HTTP");
  const target = new URL(safeTarget);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  const fetcher = runtimeAdapterFetcher(env, target, fallbackFetcher);
  const response = await fetcher.fetch(target, {
    ...init,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("runtime adapter redirect refused");
  }
  return response;
}

export function runtimeAdapterFetcher(
  env: RuntimeEnv,
  target: URL,
  fallbackFetcher: FetchTarget = globalThis,
): FetchTarget {
  const coordinator =
    runtimeAdapterControlPlaneIdentity(env.CRABBOX_COORDINATOR_ORIGIN) ??
    runtimeAdapterControlPlaneIdentity(env.CRABBOX_RUNTIME_ADAPTER_URL);
  if (!env.CRABBOX_COORDINATOR || !coordinator) return fallbackFetcher;
  const normalizedTarget = new URL(target);
  if (normalizedTarget.protocol === "wss:") normalizedTarget.protocol = "https:";
  if (normalizedTarget.protocol === "ws:") normalizedTarget.protocol = "http:";
  return new URL(coordinator).origin === normalizedTarget.origin
    ? env.CRABBOX_COORDINATOR
    : fallbackFetcher;
}

export async function interactiveTerminalFetch(
  env: RuntimeEnv,
  session: { adapter: string | null },
  url: string,
  headers: Headers,
  fallbackFetcher: FetchTarget = globalThis,
): Promise<Response> {
  const target = new URL(url);
  const fetchTarget = new URL(target);
  if (fetchTarget.protocol === "wss:") fetchTarget.protocol = "https:";
  if (fetchTarget.protocol === "ws:") fetchTarget.protocol = "http:";
  const fetcher =
    session.adapter === runtimeAdapterName
      ? runtimeAdapterFetcher(env, target, fallbackFetcher)
      : fallbackFetcher;
  return fetcher.fetch(fetchTarget, { headers });
}

export async function readRuntimeAdapterResponseBody(response: Response): Promise<unknown> {
  const body = await readBoundedResponseText(response);
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return { message: body };
  }
}
