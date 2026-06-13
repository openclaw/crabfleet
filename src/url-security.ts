export function isLiteralLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export function developmentIdentityEnabled(value: string | undefined, requestUrl: string): boolean {
  if (value !== "true") return false;
  try {
    return isLiteralLoopbackHostname(new URL(requestUrl).hostname.toLowerCase());
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
    if (url.username || url.password) return fallback;
    if (url.protocol === "https:") return url.origin;
    if (url.protocol === "http:" && isLiteralLoopbackHostname(url.hostname)) return url.origin;
    return fallback;
  } catch {
    return fallback;
  }
}
