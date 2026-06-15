import { strictSecureHttpOrigin } from "./url-security.ts";

export const trustedProxySecretHeader = "x-crabfleet-proxy-secret";
const defaultTrustedUserHeader = "x-authenticated-user";
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const loginIdentityPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,118}[A-Za-z0-9])?$/;
const emailIdentityPattern =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

export type TrustedProxyEnv = {
  CRABFLEET_TRUSTED_PROXY_ORIGIN?: string;
  CRABFLEET_TRUSTED_PROXY_PUBLIC_ORIGIN?: string;
  CRABFLEET_TRUSTED_USER_HEADER?: string;
  CRABFLEET_TRUSTED_PROXY_SECRET?: string;
};

export type TrustedProxyIdentity = {
  subject: string;
  identity: string;
  login: string | null;
  email: string | null;
  name: string;
};

export type TrustedProxyAuthResult =
  | { kind: "disabled" }
  | { kind: "outside-origin" }
  | { kind: "missing" }
  | { kind: "rejected" }
  | { kind: "authenticated"; identity: TrustedProxyIdentity };

export function inspectTrustedProxyAssertion(
  request: Request,
  env: TrustedProxyEnv,
): TrustedProxyAuthResult {
  const parsed = trustedProxyConfig(env);
  const configuredHeader = trustedUserHeader(env);
  const hasAssertion =
    request.headers.has(trustedProxySecretHeader) ||
    (configuredHeader ? request.headers.has(configuredHeader) : false);

  if (parsed.kind === "disabled") return hasAssertion ? { kind: "rejected" } : parsed;
  if (parsed.kind === "invalid") return { kind: "rejected" };

  const requestOrigin = safeRequestOrigin(request.url);
  if (requestOrigin !== parsed.origin) {
    return hasAssertion ? { kind: "rejected" } : { kind: "outside-origin" };
  }

  const suppliedSecret = request.headers.get(trustedProxySecretHeader);
  const suppliedIdentity = request.headers.get(parsed.userHeader);
  if (suppliedSecret === null && suppliedIdentity === null) return { kind: "missing" };
  if (
    suppliedSecret === null ||
    suppliedIdentity === null ||
    !constantTimeEqual(suppliedSecret, parsed.secret) ||
    !browserOriginAllowed(request, parsed.publicOrigin)
  ) {
    return { kind: "rejected" };
  }

  const identity = normalizeIdentity(suppliedIdentity);
  if (!identity) return { kind: "rejected" };
  const canonical = identity.toLowerCase();
  const email = canonical.includes("@") ? canonical : null;
  return {
    kind: "authenticated",
    identity: {
      subject: `proxy:${canonical}`,
      identity,
      login: email ? null : canonical,
      email,
      name: identity,
    },
  };
}

export function trustedProxyConfigured(env: TrustedProxyEnv): boolean {
  return trustedProxyConfig(env).kind === "configured";
}

export function trustedProxyPublicOrigin(env: TrustedProxyEnv): string | null {
  const config = trustedProxyConfig(env);
  return config.kind === "configured" ? config.publicOrigin : null;
}

export function sanitizeTrustedProxyRequest(request: Request, env: TrustedProxyEnv): Request {
  const headers = new Headers(request.headers);
  headers.delete(trustedProxySecretHeader);
  headers.delete(defaultTrustedUserHeader);
  const configuredHeader = trustedUserHeader(env);
  if (configuredHeader) headers.delete(configuredHeader);
  return new Request(request, { headers });
}

export function trustedUserHeader(env: TrustedProxyEnv): string | null {
  const header = (env.CRABFLEET_TRUSTED_USER_HEADER || defaultTrustedUserHeader).trim();
  if (
    !header ||
    !headerNamePattern.test(header) ||
    header.toLowerCase() === trustedProxySecretHeader
  ) {
    return null;
  }
  return header.toLowerCase();
}

type TrustedProxyConfig =
  | { kind: "disabled" }
  | { kind: "invalid" }
  | {
      kind: "configured";
      origin: string;
      publicOrigin: string;
      secret: string;
      userHeader: string;
    };

function trustedProxyConfig(env: TrustedProxyEnv): TrustedProxyConfig {
  const originValue = env.CRABFLEET_TRUSTED_PROXY_ORIGIN;
  const publicOriginValue = env.CRABFLEET_TRUSTED_PROXY_PUBLIC_ORIGIN;
  const secret = env.CRABFLEET_TRUSTED_PROXY_SECRET;
  const customHeader = env.CRABFLEET_TRUSTED_USER_HEADER;
  if (
    originValue === undefined &&
    publicOriginValue === undefined &&
    secret === undefined &&
    customHeader === undefined
  ) {
    return { kind: "disabled" };
  }
  const origin = strictSecureHttpOrigin(originValue);
  const publicOrigin = publicOriginValue ? strictSecureHttpOrigin(publicOriginValue) : origin;
  const userHeader = trustedUserHeader(env);
  if (!origin || !publicOrigin || !secret || !userHeader) return { kind: "invalid" };
  return { kind: "configured", origin, publicOrigin, secret, userHeader };
}

function safeRequestOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function browserOriginAllowed(request: Request, trustedOrigin: string): boolean {
  const websocket = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  const unsafeMethod = !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase());
  return !websocket && !unsafeMethod ? true : request.headers.get("origin") === trustedOrigin;
}

function normalizeIdentity(value: string): string | null {
  if (value.length > 320 || containsControlCharacter(value)) return null;
  const identity = value.trim();
  if (!identity || identity.length > 320) return null;
  return loginIdentityPattern.test(identity) || emailIdentityPattern.test(identity)
    ? identity
    : null;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
