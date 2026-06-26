import { isLiteralLoopbackHostname } from "./url-security.ts";

export const githubOAuthCallbackPath = "/auth/github/callback";
export const githubOAuthLoginPath = "/login/github";

export function githubOAuthRedirectUri(requestUrl: string | URL, configured?: string): string {
  if (configured !== undefined) return configuredGitHubOAuthRedirectUri(configured);
  const url = new URL(requestUrl);
  if (url.username || url.password)
    throw new Error("GitHub OAuth request URL cannot use credentials");
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLiteralLoopbackHostname(url.hostname))
  ) {
    throw new Error("GitHub OAuth request URL must use HTTPS or loopback HTTP");
  }
  return `${url.origin}${githubOAuthCallbackPath}`;
}

export function githubOAuthCanonicalLoginUrl(
  requestUrl: string | URL,
  configured?: string,
): string | null {
  if (configured === undefined) return null;
  const callback = new URL(configuredGitHubOAuthRedirectUri(configured));
  const request = new URL(requestUrl);
  if (
    request.protocol === "https:" &&
    !request.username &&
    !request.password &&
    request.origin === callback.origin
  ) {
    return null;
  }
  return `${callback.origin}${githubOAuthLoginPath}`;
}

export function githubOAuthCanonicalSshLinkUrl(
  requestUrl: string | URL,
  code: string,
  configured?: string,
): string | null {
  if (configured === undefined) return null;
  const callback = new URL(configuredGitHubOAuthRedirectUri(configured));
  const request = new URL(requestUrl);
  if (
    request.protocol === "https:" &&
    !request.username &&
    !request.password &&
    request.origin === callback.origin
  ) {
    return null;
  }
  return `${callback.origin}/ssh/link/${encodeURIComponent(code)}`;
}

export function githubOAuthCanonicalNativeLinkUrl(
  requestUrl: string | URL,
  code: string,
  configured?: string,
): string | null {
  if (configured === undefined) return null;
  const callback = new URL(configuredGitHubOAuthRedirectUri(configured));
  const request = new URL(requestUrl);
  if (
    request.protocol === "https:" &&
    !request.username &&
    !request.password &&
    request.origin === callback.origin
  ) {
    return null;
  }
  return `${callback.origin}/native/link/${encodeURIComponent(code)}`;
}

export function githubOAuthCallbackRequestMatches(
  requestUrl: string | URL,
  configured?: string,
): boolean {
  if (configured === undefined) return true;
  const callback = new URL(configuredGitHubOAuthRedirectUri(configured));
  const request = new URL(requestUrl);
  return (
    request.protocol === "https:" &&
    !request.username &&
    !request.password &&
    request.origin === callback.origin &&
    request.pathname === githubOAuthCallbackPath
  );
}

function configuredGitHubOAuthRedirectUri(configured: string): string {
  if (!configured || configured !== configured.trim()) {
    throw new Error("GITHUB_REDIRECT_URI must be an exact HTTPS URL");
  }
  if (/\s/u.test(configured)) {
    throw new Error("GITHUB_REDIRECT_URI cannot contain whitespace or controls");
  }
  if (!/^https:\/\/[^/]/iu.test(configured)) {
    throw new Error("GITHUB_REDIRECT_URI must be an absolute HTTPS URL");
  }
  for (let index = 0; index < configured.length; index += 1) {
    const code = configured.charCodeAt(index);
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) {
      throw new Error("GITHUB_REDIRECT_URI cannot contain whitespace or controls");
    }
  }
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("GITHUB_REDIRECT_URI must be an absolute HTTPS URL");
  }
  if (url.protocol !== "https:" || !url.hostname) {
    throw new Error("GITHUB_REDIRECT_URI must be an absolute HTTPS URL");
  }
  const authority = configured.slice(configured.indexOf("//") + 2).split("/", 1)[0] ?? "";
  if (url.username || url.password || authority.includes("@")) {
    throw new Error("GITHUB_REDIRECT_URI cannot use URL credentials");
  }
  if (url.pathname !== githubOAuthCallbackPath) {
    throw new Error(`GITHUB_REDIRECT_URI path must be ${githubOAuthCallbackPath}`);
  }
  if (url.search || configured.includes("?")) {
    throw new Error("GITHUB_REDIRECT_URI cannot include a query string");
  }
  if (url.hash || configured.includes("#")) {
    throw new Error("GITHUB_REDIRECT_URI cannot include a fragment");
  }
  return `${url.origin}${githubOAuthCallbackPath}`;
}
