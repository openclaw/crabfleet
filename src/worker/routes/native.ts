import type { TrustedProxyAuthResult } from "../../trusted-proxy-auth.ts";
import { requireRole } from "../auth.ts";
import type { PublicDeploymentConfig } from "../deployment.ts";
import { badRequest, json, unauthorized } from "../http.ts";
import type { User } from "../models.ts";

const nativeJsonBodyLimitBytes = 1024;

export type NativeRouteDependencies = {
  startDevice(clientName: unknown, remoteIp: unknown): Promise<unknown>;
  pollToken(deviceCode: unknown): Promise<
    | { kind: "pending"; intervalSeconds: number }
    | { kind: "slow_down"; intervalSeconds: number }
    | {
        kind: "authorized";
        accessToken: string;
        expiresAt: number;
        user: User;
      }
  >;
  requireUser(request: Request): Promise<User>;
  revokeToken(request: Request): Promise<void>;
  readFleet(user: User): Promise<unknown>;
  createNativeVNCGrant(user: User, sessionId: string): Promise<unknown>;
  deployment: PublicDeploymentConfig;
};

export async function handleNativeRoute(
  request: Request,
  url: URL,
  requestAuth: TrustedProxyAuthResult,
  dependencies: NativeRouteDependencies,
): Promise<Response | null> {
  if (request.method === "POST" && url.pathname === "/api/native/v1/auth/device") {
    rejectAmbiguousProxyBearer(request, requestAuth);
    const body = await readNativeJson<{ clientName?: unknown }>(request);
    return json(
      await dependencies.startDevice(body.clientName, request.headers.get("cf-connecting-ip")),
      { status: 201 },
    );
  }
  if (request.method === "POST" && url.pathname === "/api/native/v1/auth/token") {
    rejectAmbiguousProxyBearer(request, requestAuth);
    const body = await readNativeJson<{ deviceCode?: unknown }>(request);
    const result = await dependencies.pollToken(body.deviceCode);
    if (result.kind === "pending") {
      return json(
        { status: "pending" },
        { status: 202, headers: { "retry-after": String(result.intervalSeconds) } },
      );
    }
    if (result.kind === "slow_down") {
      return json(
        { error: "slow_down" },
        { status: 429, headers: { "retry-after": String(result.intervalSeconds) } },
      );
    }
    return json({
      accessToken: result.accessToken,
      tokenType: "Bearer",
      expiresAt: result.expiresAt,
      user: result.user,
    });
  }

  if (request.method === "DELETE" && url.pathname === "/api/native/v1/auth/token") {
    rejectAmbiguousProxyBearer(request, requestAuth);
    await dependencies.revokeToken(request);
    return json({ ok: true });
  }
  if (request.method === "GET" && url.pathname === "/api/native/v1/session") {
    rejectAmbiguousProxyBearer(request, requestAuth);
    const user = await dependencies.requireUser(request);
    requireRole(user, "viewer");
    return json({ user, deployment: dependencies.deployment });
  }
  if (request.method === "GET" && url.pathname === "/api/native/v1/fleet") {
    rejectAmbiguousProxyBearer(request, requestAuth);
    const user = await dependencies.requireUser(request);
    requireRole(user, "viewer");
    return json({ fleet: await dependencies.readFleet(user) });
  }
  const nativeVNCMatch = /^\/api\/native\/v1\/sessions\/(IS-[1-9][0-9]*)\/native-vnc$/u.exec(
    url.pathname,
  );
  if (request.method === "POST" && nativeVNCMatch) {
    rejectAmbiguousProxyBearer(request, requestAuth);
    const user = await dependencies.requireUser(request);
    requireRole(user, "viewer");
    return json(
      { grant: await dependencies.createNativeVNCGrant(user, nativeVNCMatch[1]!) },
      { headers: { "cache-control": "no-store" } },
    );
  }
  return null;
}

function rejectAmbiguousProxyBearer(request: Request, requestAuth: TrustedProxyAuthResult): void {
  if (requestAuth.kind === "authenticated" && request.headers.has("authorization")) {
    throw unauthorized();
  }
}

async function readNativeJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw badRequest("content-type must be application/json");
  }
  const declaredLength = request.headers.get("content-length");
  if (/^\d+$/u.test(declaredLength ?? "") && Number(declaredLength) > nativeJsonBodyLimitBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw requestBodyTooLarge();
  }
  if (!request.body) throw badRequest("invalid json");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (total + value.byteLength > nativeJsonBodyLimitBytes) {
        await reader.cancel().catch(() => undefined);
        throw requestBodyTooLarge();
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw badRequest("invalid json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest("json body must be an object");
  }
  return parsed as T;
}

function requestBodyTooLarge(): Error & { status: number } {
  return Object.assign(new Error("request body too large"), { status: 413 });
}
