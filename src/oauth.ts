export const githubOAuthCallbackPath = "/auth/github/callback";

export function githubOAuthRedirectUri(requestUrl: string | URL, configured?: string): string {
  const trimmed = configured?.trim();
  if (trimmed) return new URL(trimmed).toString();
  const url = new URL(requestUrl);
  return `${url.origin}${githubOAuthCallbackPath}`;
}
