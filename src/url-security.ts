type ProtocolPair = {
  secure: "https:" | "wss:";
  loopback: "http:" | "ws:";
};

const httpProtocols: ProtocolPair = { secure: "https:", loopback: "http:" };
const webSocketProtocols: ProtocolPair = { secure: "wss:", loopback: "ws:" };
const exactLoopbackAuthorityPattern =
  /^[a-z][a-z0-9+.-]*:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:[/?#]|$)/iu;

export function isLiteralLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export function exactSecureHttpUrl(value: unknown): string | null {
  return secureOrLoopbackUrl(value, httpProtocols, true);
}

export function exactSecureWebSocketUrl(value: unknown): string | null {
  return secureOrLoopbackUrl(value, webSocketProtocols, true);
}

export function normalizedSecureHttpUrl(value: unknown): string | null {
  return secureOrLoopbackUrl(value, httpProtocols, false);
}

export function normalizedSecureWebSocketUrl(value: unknown): string | null {
  return secureOrLoopbackUrl(value, webSocketProtocols, false);
}

export function strictSecureHttpOrigin(value: string | undefined): string | null {
  const raw = exactUrlString(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !usesSecureOrLoopbackProtocol(raw, url, httpProtocols)
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function developmentIdentityEnabled(value: string | undefined, requestUrl: string): boolean {
  if (value !== "true") return false;
  try {
    return isLiteralLoopbackHostname(new URL(requestUrl).hostname);
  } catch {
    return false;
  }
}

export function configuredHttpOrigin(value: string | undefined, fallback: string): string {
  const candidate = String(value ?? "")
    .trim()
    .slice(0, 1000);
  if (!candidate) return fallback;
  try {
    const url = new URL(candidate);
    return url.username ||
      url.password ||
      !usesSecureOrLoopbackProtocol(candidate, url, httpProtocols)
      ? fallback
      : url.origin;
  } catch {
    return fallback;
  }
}

function secureOrLoopbackUrl(
  value: unknown,
  protocols: ProtocolPair,
  preserveExact: boolean,
): string | null {
  const raw = exactUrlString(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password || !usesSecureOrLoopbackProtocol(raw, url, protocols)) {
      return null;
    }
    return preserveExact ? raw : url.toString();
  } catch {
    return null;
  }
}

function usesSecureOrLoopbackProtocol(raw: string, url: URL, protocols: ProtocolPair): boolean {
  if (url.protocol === protocols.secure) return true;
  return (
    url.protocol === protocols.loopback &&
    isLiteralLoopbackHostname(url.hostname) &&
    exactLoopbackAuthorityPattern.test(raw)
  );
}

function exactUrlString(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return null;
  }
  return value;
}
