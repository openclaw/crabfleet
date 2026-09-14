import type { TrustedProxyAuthResult } from "../trusted-proxy-auth.ts";
import { githubOAuthCanonicalNativeLinkUrl, githubOAuthRedirectUri } from "../oauth.ts";
import {
  actor,
  authMethods,
  optionalUser,
  requireRole,
  requireUser,
  sessionGitHubToken,
} from "./auth.ts";
import { sha256 } from "./crypto.ts";
import { browserAppOrigin } from "./deployment.ts";
import type { RuntimeEnv } from "./env.ts";
import { badRequest, cookie, cookies, forbidden, readBoundedText, redirect, text } from "./http.ts";
import { connectorAccessScope, type NativeAuthService } from "./native-auth.ts";

export const nativeLinkCookie = "crabbox_native_link";
const nativeLinkCsrfCookie = "crabbox_native_link_csrf";
const nativeLinkSeconds = 10 * 60;
const nativeLinkFormLimitBytes = 1024;
const nativeLinkHtmlHeaders = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  // A no-referrer policy serializes same-origin form POSTs as Origin: null in Chromium.
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
};

export async function handleNativeLink(
  request: Request,
  code: string,
  requestAuth: TrustedProxyAuthResult,
  env: RuntimeEnv,
  service: NativeAuthService,
): Promise<Response> {
  const canonicalLinkUrl = githubOAuthCanonicalNativeLinkUrl(
    request.url,
    code,
    env.GITHUB_REDIRECT_URI,
  );
  if (
    canonicalLinkUrl &&
    (requestAuth.kind !== "authenticated" ||
      new URL(canonicalLinkUrl).origin !== browserAppOrigin(env))
  ) {
    return redirect(canonicalLinkUrl, { "cache-control": "no-store" });
  }
  const link = await service.link(code).catch((error: unknown) => {
    if (httpStatus(error) !== 401) throw error;
    return null;
  });
  if (!link || link.expiresAt <= Date.now()) {
    return text(
      nativeLinkPage(
        "This sign-in link expired",
        "<p>Start sign-in again from Crabfleet on your computer, then open the new authorization link.</p>",
      ),
      "text/html; charset=utf-8",
      nativeLinkHtmlHeaders,
      410,
    );
  }
  if (link.approvedAt || link.consumedAt) {
    return text(
      nativeLinkPage(
        "This link has already been used",
        "<p>Return to Crabfleet on your computer to continue. If you still need to sign in, start again there to get a new link.</p>",
      ),
      "text/html; charset=utf-8",
      nativeLinkHtmlHeaders,
      410,
    );
  }

  if (request.method === "POST") {
    if (request.headers.get("origin") !== nativeLinkApprovalOrigin(request, env)) {
      throw forbidden("native authorization origin is invalid");
    }
    if (requestAuth.kind !== "authenticated" && !cookies(request).has(nativeLinkCsrfCookie)) {
      throw forbidden("native authorization confirmation is invalid");
    }
    const csrf = await readNativeLinkCsrf(request);
    const expectedCookie = `${await sha256(code)}.${csrf}`;
    if (
      !csrf ||
      (requestAuth.kind !== "authenticated" &&
        cookies(request).get(nativeLinkCsrfCookie) !== expectedCookie)
    ) {
      throw forbidden("native authorization confirmation is invalid");
    }
    const user = await requireUser(request, env, requestAuth);
    if (user.subject.startsWith("dev:")) {
      throw forbidden("development identities cannot authorize native clients");
    }
    requireRole(user, "viewer");
    const githubToken = user.subject.startsWith("github:")
      ? await sessionGitHubToken(request, env, user.subject)
      : undefined;
    if (user.subject.startsWith("github:") && !githubToken) {
      throw forbidden("Sign in with GitHub again before authorizing a native client");
    }
    const approved = await service.approve(code, user, githubToken);
    const response = text(
      nativeLinkSuccessHtml(approved.clientName, actor(user), link.scope === connectorAccessScope),
      "text/html; charset=utf-8",
      nativeLinkHtmlHeaders,
    );
    response.headers.append("set-cookie", cookie(request, nativeLinkCookie, "", 0));
    response.headers.append("set-cookie", cookie(request, nativeLinkCsrfCookie, "", 0));
    return response;
  }

  const user = await optionalUser(request, env, requestAuth);
  if (!user) {
    if (!authMethods(env, request).github) {
      return text(
        nativeLinkPage(
          "Sign in to continue",
          '<p>Sign in to this Crabfleet deployment in your browser, then reopen the authorization link.</p><p><a href="/">Open Crabfleet</a></p>',
        ),
        "text/html; charset=utf-8",
        nativeLinkHtmlHeaders,
        401,
      );
    }
    return redirect("/login/github?flow=native", {
      "cache-control": "no-store",
      "set-cookie": cookie(request, nativeLinkCookie, code, nativeLinkSeconds),
    });
  }

  const csrf = crypto.randomUUID() + crypto.randomUUID();
  const response = text(
    nativeLinkConfirmHtml(
      code,
      csrf,
      link.clientName,
      actor(user),
      link.scope === connectorAccessScope,
    ),
    "text/html; charset=utf-8",
    nativeLinkHtmlHeaders,
  );
  if (requestAuth.kind !== "authenticated") {
    response.headers.append(
      "set-cookie",
      cookie(request, nativeLinkCsrfCookie, `${await sha256(code)}.${csrf}`, nativeLinkSeconds),
    );
  }
  return response;
}

function nativeLinkConfirmHtml(
  code: string,
  csrf: string,
  clientName: string,
  user: string,
  connector = false,
): string {
  return nativeLinkPage(
    connector ? "Authorize Crabfleet Connect" : "Authorize Crabfleet for macOS",
    `
  <p>Signed in as <strong>${htmlEscape(user)}</strong>.</p>
  <p>Allow <code>${htmlEscape(clientName)}</code> to ${connector ? "publish and manage your shared desktops? The connector can renew this authorization while it is running. Desktop capture and control still require permission on that computer." : "discover your shared desktops for 24 hours?"}</p>
  <form method="post" action="/native/link/${encodeURIComponent(code)}">
    <input type="hidden" name="csrf" value="${htmlEscape(csrf)}">
    <button type="submit">${connector ? "Authorize this connector" : "Authorize this Mac"}</button>
  </form>`,
  );
}

function nativeLinkSuccessHtml(clientName: string, user: string, connector = false): string {
  return nativeLinkPage(
    "Crabfleet authorized",
    `<p><strong>${htmlEscape(clientName)}</strong> can now ${connector ? "publish shared desktops for" : "discover the desktops shared by"} ${htmlEscape(user)}.</p><p>Return to the computer where you started sign-in. You can close this window.</p>`,
  );
}

function nativeLinkPage(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>${htmlEscape(title)}</title>
  <style>
    *{box-sizing:border-box}
    :root{color-scheme:light dark;--background:#f5f3ec;--panel:#fffef9;--ink:#202821;--muted:#687267;--border:#d9ddd3;--accent:#b8442b;--button-text:#fffef9}
    @media(prefers-color-scheme:dark){:root{--background:#141b18;--panel:#1c2520;--ink:#f3f2e9;--muted:#a4b0a5;--border:#344139;--accent:#ed7255;--button-text:#141b18}}
    body{font:16px/1.6 "Trebuchet MS",system-ui,sans-serif;margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:max(24px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left));color:var(--ink);background:var(--background)}
    main{width:100%;max-width:36rem;min-width:0;padding:clamp(20px,5vw,40px);border:1px solid var(--border);border-top:3px solid var(--accent);border-radius:12px;background:var(--panel)}
    .brand{font:600 .75rem/1.4 monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);margin:0 0 32px}
    h1{font:normal clamp(1.8rem,7vw,2.4rem)/1.12 Georgia,serif;margin:0 0 24px;overflow-wrap:anywhere}
    p{overflow-wrap:anywhere;color:var(--muted)}
    strong{color:var(--ink)}
    code{border:1px solid var(--border);padding:.15rem .35rem;border-radius:.25rem;overflow-wrap:anywhere}
    form{margin-top:28px}
    button{font:inherit;font-weight:600;min-height:48px;width:100%;padding:12px 16px;border:0;border-radius:6px;background:var(--accent);color:var(--button-text);cursor:pointer}
    a{color:var(--accent);display:inline-flex;align-items:center;min-height:44px}
    button:focus-visible,a:focus-visible{outline:3px solid var(--ink);outline-offset:4px}
  </style>
</head>
<body><main><p class="brand">Crabfleet / Secure sign-in</p><h1>${htmlEscape(title)}</h1>${content}</main></body>
</html>`;
}

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function httpStatus(error: unknown): number | undefined {
  return typeof error === "object" && error && "status" in error ? Number(error.status) : undefined;
}

async function readNativeLinkCsrf(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/iu.test(contentType)) {
    throw badRequest("invalid native authorization form");
  }
  const body = await readBoundedText(request, nativeLinkFormLimitBytes, {
    emptyBodyMessage: "invalid native authorization form",
    tooLargeMessage: "request body too large",
  });
  return new URLSearchParams(body).get("csrf") ?? "";
}

function nativeLinkApprovalOrigin(request: Request, env: RuntimeEnv): string {
  return env.GITHUB_REDIRECT_URI
    ? new URL(githubOAuthRedirectUri(request.url, env.GITHUB_REDIRECT_URI)).origin
    : browserAppOrigin(env);
}
