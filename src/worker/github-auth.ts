import {
  githubOAuthCallbackRequestMatches,
  githubOAuthCanonicalLoginUrl,
  githubOAuthRedirectUri,
} from "../oauth.ts";
import { authorize, createSession, githubSessionSeconds, upsertUser } from "./auth.ts";
import type { RuntimeEnv } from "./env.ts";
import { refreshGitHubUser, type Fetcher } from "./github.ts";
import { cookie, cookies, redirect, serviceUnavailable, text } from "./http.ts";
import { nativeLinkCookie } from "./native-link.ts";

const oauthStateCookie = "crabbox_oauth_state";
const oauthFlowParameter = "flow";
export const sshLinkCookie = "crabbox_ssh_link";

type OAuthReturnTarget = { kind: "ssh" | "native"; code: string };
type OAuthStateBinding = {
  nonce: string;
  returnTo: OAuthReturnTarget | null;
  legacy: boolean;
};

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
  const nonce = crypto.randomUUID();
  const state = JSON.stringify({
    version: 1,
    nonce,
    returnTo: requestedOAuthReturnTarget(url, cookies(request)),
  });
  const target = new URL("https://github.com/login/oauth/authorize");
  target.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  target.searchParams.set("redirect_uri", redirectUri);
  target.searchParams.set("scope", "read:user read:org repo");
  target.searchParams.set("state", nonce);

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
  const requestCookies = cookies(request);
  const stateBinding = readOAuthStateBinding(requestCookies.get(oauthStateCookie));
  if (!code || !state || !stateBinding || state !== stateBinding.nonce) {
    return text("Invalid OAuth state.\n", "text/plain; charset=utf-8", {}, 400);
  }

  const oauthSignal = AbortSignal.timeout(10_000);
  const timedFetcher: Fetcher = (input, init) =>
    fetcher(input, { ...init, signal: init?.signal ?? oauthSignal });
  const tokenResponse = await timedFetcher("https://github.com/login/oauth/access_token", {
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

  const freshUser = await refreshGitHubUser(env, tokenBody.access_token, timedFetcher).catch(() => {
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
  const returnTo = stateBinding.legacy
    ? legacyOAuthReturnTarget(requestCookies)
    : stateBinding.returnTo;
  return redirect(
    returnTo?.kind === "ssh"
      ? `/ssh/link/${encodeURIComponent(returnTo.code)}`
      : returnTo?.kind === "native"
        ? `/native/link/${encodeURIComponent(returnTo.code)}`
        : "/app?login=github",
    {
      "set-cookie": session,
    },
  );
}

function requestedOAuthReturnTarget(
  url: URL,
  requestCookies: ReadonlyMap<string, string>,
): OAuthReturnTarget | null {
  const kind = url.searchParams.get(oauthFlowParameter);
  if (kind !== "ssh" && kind !== "native") return null;
  const code = requestCookies.get(kind === "ssh" ? sshLinkCookie : nativeLinkCookie);
  return validOAuthLinkCode(code) ? { kind, code } : null;
}

function readOAuthStateBinding(value: string | undefined): OAuthStateBinding | null {
  if (!value) return null;
  try {
    const decoded: unknown = JSON.parse(value);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const parsed = decoded as {
      version?: unknown;
      nonce?: unknown;
      returnTo?: { kind?: unknown; code?: unknown } | null;
    };
    if (parsed.version !== 1 || !validOAuthNonce(parsed.nonce)) return null;
    if (parsed.returnTo === null) {
      return { nonce: parsed.nonce, returnTo: null, legacy: false };
    }
    const kind = parsed.returnTo?.kind;
    const code = parsed.returnTo?.code;
    if ((kind !== "ssh" && kind !== "native") || !validOAuthLinkCode(code)) return null;
    return { nonce: parsed.nonce, returnTo: { kind, code }, legacy: false };
  } catch {
    return validOAuthNonce(value) ? { nonce: value, returnTo: null, legacy: true } : null;
  }
}

function legacyOAuthReturnTarget(
  requestCookies: ReadonlyMap<string, string>,
): OAuthReturnTarget | null {
  const sshCode = requestCookies.get(sshLinkCookie);
  if (validOAuthLinkCode(sshCode)) return { kind: "ssh", code: sshCode };
  const nativeCode = requestCookies.get(nativeLinkCookie);
  return validOAuthLinkCode(nativeCode) ? { kind: "native", code: nativeCode } : null;
}

function validOAuthNonce(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/\s/u.test(value);
}

function validOAuthLinkCode(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 500 && !/\s/u.test(value);
}
