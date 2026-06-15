import {
  githubOAuthCallbackRequestMatches,
  githubOAuthCanonicalLoginUrl,
  githubOAuthRedirectUri,
} from "../oauth.ts";
import { authorize, createSession, githubSessionSeconds, upsertUser } from "./auth.ts";
import type { RuntimeEnv } from "./env.ts";
import { refreshGitHubUser, type Fetcher } from "./github.ts";
import { cookie, cookies, redirect, serviceUnavailable, text } from "./http.ts";

const oauthStateCookie = "crabbox_oauth_state";
export const sshLinkCookie = "crabbox_ssh_link";

export async function githubLogin(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return text("GitHub OAuth is not configured.\n", "text/plain; charset=utf-8", {}, 503);
  }

  const url = new URL(request.url);
  const redirectUri = githubOAuthRedirectUri(url, env.GITHUB_REDIRECT_URI);
  const canonicalLoginUrl = githubOAuthCanonicalLoginUrl(url, env.GITHUB_REDIRECT_URI);
  if (canonicalLoginUrl) {
    return redirect(canonicalLoginUrl, { "cache-control": "no-store" });
  }
  const state = crypto.randomUUID();
  const target = new URL("https://github.com/login/oauth/authorize");
  target.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  target.searchParams.set("redirect_uri", redirectUri);
  target.searchParams.set("scope", "read:user read:org repo");
  target.searchParams.set("state", state);

  return redirect(target.toString(), {
    "set-cookie": cookie(request, oauthStateCookie, state, 600),
  });
}

export async function githubCallback(
  request: Request,
  env: RuntimeEnv,
  fetcher: Fetcher = fetch,
): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return text("GitHub OAuth is not configured.\n", "text/plain; charset=utf-8", {}, 503);
  }

  const url = new URL(request.url);
  const redirectUri = githubOAuthRedirectUri(url, env.GITHUB_REDIRECT_URI);
  if (!githubOAuthCallbackRequestMatches(url, env.GITHUB_REDIRECT_URI)) {
    return text(
      "OAuth callback host does not match configured redirect URI.\n",
      "text/plain; charset=utf-8",
      {},
      400,
    );
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || state !== cookies(request).get(oauthStateCookie)) {
    return text("Invalid OAuth state.\n", "text/plain; charset=utf-8", {}, 400);
  }

  const tokenResponse = await fetcher("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "crabbox-ai",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      state,
    }),
  });
  const tokenBody = await tokenResponse.json<{ access_token?: string; error?: string }>();
  if (!tokenBody.access_token) {
    return text(
      tokenBody.error ?? "OAuth token exchange failed.\n",
      "text/plain; charset=utf-8",
      {},
      401,
    );
  }

  const freshUser = await refreshGitHubUser(env, tokenBody.access_token, fetcher).catch(() => {
    throw serviceUnavailable("GitHub membership refresh failed; retry later");
  });
  if (!freshUser) {
    return text(
      "GitHub user is not an active OpenClaw org member.\n",
      "text/plain; charset=utf-8",
      {},
      403,
    );
  }
  const authorized = await authorize(env, freshUser);
  if (!authorized.allowed) {
    return text(
      "GitHub user is not in the Crabfleet allowlist.\n",
      "text/plain; charset=utf-8",
      {},
      403,
    );
  }

  const now = Date.now();
  await upsertUser(env, authorized, now);
  const session = await createSession(
    env,
    request,
    authorized.subject,
    now,
    githubSessionSeconds,
    tokenBody.access_token,
  );
  const pendingSshCode = cookies(request).get(sshLinkCookie);
  return redirect(
    pendingSshCode ? `/ssh/link/${encodeURIComponent(pendingSshCode)}` : "/app?login=github",
    {
      "set-cookie": session,
    },
  );
}
