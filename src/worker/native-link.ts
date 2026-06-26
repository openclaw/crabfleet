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
import { badRequest, cookie, cookies, forbidden, redirect, text } from "./http.ts";
import type { NativeAuthService } from "./native-auth.ts";

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
      "Native app authorization expired. Start sign-in again from the Crabfleet app.\n",
      "text/plain; charset=utf-8",
      { "cache-control": "no-store" },
      410,
    );
  }
  if (link.approvedAt || link.consumedAt) {
    return text(
      "Native app authorization is no longer pending.\n",
      "text/plain; charset=utf-8",
      { "cache-control": "no-store" },
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
      nativeLinkSuccessHtml(approved.clientName, actor(user)),
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
        "Sign in to this Crabfleet deployment in your browser, then reopen the authorization link.\n",
        "text/plain; charset=utf-8",
        { "cache-control": "no-store" },
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
    nativeLinkConfirmHtml(code, csrf, link.clientName, actor(user)),
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
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorize Crabfleet for macOS</title>
  <style>
    body{font:16px/1.45 system-ui,sans-serif;margin:3rem;max-width:44rem;color:#111;background:#fff}
    code{background:#f3f4f6;padding:.15rem .35rem;border-radius:.25rem;word-break:break-all}
    button{font:inherit;padding:.65rem 1rem;border:0;border-radius:.4rem;background:#111;color:#fff}
  </style>
</head>
<body>
  <h1>Authorize Crabfleet for macOS</h1>
  <p>Signed in as <strong>${htmlEscape(user)}</strong>.</p>
  <p>Allow <code>${htmlEscape(clientName)}</code> to read your visible Crabfleet sessions for 24 hours?</p>
  <form method="post" action="/native/link/${encodeURIComponent(code)}">
    <input type="hidden" name="csrf" value="${htmlEscape(csrf)}">
    <button type="submit">Authorize this Mac</button>
  </form>
</body>
</html>`;
}

function nativeLinkSuccessHtml(clientName: string, user: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Crabfleet authorized</title></head>
<body style="font:16px/1.45 system-ui,sans-serif;margin:3rem;max-width:44rem">
  <h1>Crabfleet authorized</h1>
  <p><strong>${htmlEscape(clientName)}</strong> can now read the sessions visible to ${htmlEscape(user)}. You can close this window.</p>
</body>
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
  const declaredLength = request.headers.get("content-length");
  if (/^\d+$/u.test(declaredLength ?? "") && Number(declaredLength) > nativeLinkFormLimitBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw requestBodyTooLarge();
  }
  if (!request.body) throw badRequest("invalid native authorization form");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (total + value.byteLength > nativeLinkFormLimitBytes) {
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
  try {
    return new URLSearchParams(new TextDecoder().decode(body)).get("csrf") ?? "";
  } catch {
    throw badRequest("invalid native authorization form");
  }
}

function requestBodyTooLarge(): Error & { status: number } {
  return Object.assign(new Error("request body too large"), { status: 413 });
}

function nativeLinkApprovalOrigin(request: Request, env: RuntimeEnv): string {
  return env.GITHUB_REDIRECT_URI
    ? new URL(githubOAuthRedirectUri(request.url, env.GITHUB_REDIRECT_URI)).origin
    : browserAppOrigin(env);
}
