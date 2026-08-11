import { sql } from "kysely";

import { githubOAuthCanonicalSshLinkUrl, githubOAuthRedirectUri } from "../oauth.ts";
import { preferredEnabledRepo } from "../repo-selection.ts";
import type { TrustedProxyAuthResult } from "../trusted-proxy-auth.ts";
import {
  actor,
  authorize,
  optionalUser,
  requireRole,
  requireUser,
  sessionGitHubToken,
  upsertUser,
} from "./auth.ts";
import { openSecret, sealSecret, sha256 } from "./crypto.ts";
import { database, executeBatch } from "./database.ts";
import { deploymentConfig } from "./deployment.ts";
import type { RuntimeEnv } from "./env.ts";
import { refreshGitHubUser } from "./github.ts";
import { sshLinkCookie } from "./github-auth.ts";
import {
  badRequest,
  conflict,
  cookie,
  forbidden,
  readJson,
  redirect,
  serviceUnavailable,
  text,
  tooManyRequests,
  unauthorized,
} from "./http.ts";
import type { User } from "./models.ts";
import { normalizeRepo } from "./repositories.ts";
import type { InteractiveSessionCreateRequest } from "./session-create-request.ts";
import type { InteractiveSession } from "./session-model.ts";

const sshLinkSeconds = 5 * 60;

export type SshGatewayDependencies = {
  readState(request: Request, user: User): Promise<Record<string, unknown>>;
  createSession(
    user: User,
    body: InteractiveSessionCreateRequest,
    githubToken: string | undefined,
  ): Promise<{ session: InteractiveSession }>;
  audit(user: User, message: string, now: number): Promise<void>;
};

export class SshGateway {
  private readonly env: RuntimeEnv;
  private readonly dependencies: SshGatewayDependencies;

  constructor(env: RuntimeEnv, dependencies: SshGatewayDependencies) {
    this.env = env;
    this.dependencies = dependencies;
  }

  async link(
    request: Request,
    code: string,
    requestAuth: TrustedProxyAuthResult,
  ): Promise<Response> {
    const canonicalLinkUrl = githubOAuthCanonicalSshLinkUrl(
      request.url,
      code,
      this.env.GITHUB_REDIRECT_URI,
    );
    if (canonicalLinkUrl) {
      return redirect(canonicalLinkUrl, { "cache-control": "no-store" });
    }
    const codeHash = await sha256(code);
    const row = await database(this.env)
      .selectFrom("ssh_link_codes")
      .select(["fingerprint", "label", "expires_at", "consumed_at"])
      .where("code_hash", "=", codeHash)
      .executeTakeFirst();
    if (!row || row.consumed_at || row.expires_at <= Date.now()) {
      return text(
        "SSH link expired. Re-run ssh link@crabd.sh to get a fresh link.\n",
        "text/plain",
        {},
        410,
      );
    }

    if (request.method === "POST") {
      const user = await requireUser(request, this.env, requestAuth);
      if (!user.subject.startsWith("github:")) {
        throw forbidden("Sign in with GitHub before linking an SSH key");
      }
      const githubToken = await sessionGitHubToken(request, this.env, user.subject);
      if (!githubToken) {
        throw forbidden("Sign in with GitHub again before linking an SSH key");
      }
      await this.consumeLink(user, code, Date.now(), githubToken);
      return redirect("/app?ssh=linked&login=github", {
        "set-cookie": cookie(request, sshLinkCookie, "", 0),
      });
    }

    const user = await optionalUser(request, this.env, requestAuth);
    if (user) {
      if (!user.subject.startsWith("github:")) {
        return text(
          "Sign in with GitHub before linking an SSH key.\n",
          "text/plain; charset=utf-8",
          { "cache-control": "no-store" },
          403,
        );
      }
      return text(
        sshLinkConfirmHtml(code, row.fingerprint, row.label, actor(user)),
        "text/html; charset=utf-8",
        { "cache-control": "no-store" },
      );
    }

    return redirect("/login/github?flow=ssh", {
      "set-cookie": cookie(request, sshLinkCookie, code, sshLinkSeconds),
    });
  }

  async authenticate(request: Request): Promise<Record<string, unknown>> {
    this.requireGateway(request);
    const body = await readJson<{
      fingerprint?: string;
      publicKey?: string;
      label?: string;
      remoteIp?: string;
      createLink?: boolean;
    }>(request);
    const fingerprint = clean(body.fingerprint, 120);
    const publicKey = clean(body.publicKey, 4000);
    const label = clean(body.label, 200) || null;
    const remoteIp = clean(body.remoteIp, 120) || null;
    if (!fingerprint || !publicKey) throw badRequest("fingerprint and publicKey are required");

    const now = Date.now();
    if (!body.createLink) {
      const user = await this.readUser(fingerprint);
      if (!user) return { authorized: false };
      const attached = await database(this.env)
        .updateTable("ssh_keys")
        .set({ last_used_at: now })
        .where("fingerprint", "=", fingerprint)
        .executeTakeFirst();
      if ((attached.numUpdatedRows ?? 0n) === 0n) {
        throw conflict("interactive session lifecycle changed; retry attach");
      }
      return { authorized: true, user };
    }

    const db = database(this.env);
    await db.deleteFrom("ssh_link_codes").where("expires_at", "<=", now).execute();
    if (remoteIp) {
      const recent =
        (
          await sql<{ count: number }>`
            SELECT count(*) AS count
            FROM ssh_link_codes
            WHERE remote_ip = ${remoteIp}
              AND consumed_at IS NULL
              AND created_at > ${now - 10 * 60 * 1000}
          `.execute(db)
        ).rows[0]?.count ?? 0;
      if (recent >= 20) throw tooManyRequests("too many SSH link attempts; retry later");
    }
    await db
      .deleteFrom("ssh_link_codes")
      .where("fingerprint", "=", fingerprint)
      .where("consumed_at", "is", null)
      .execute();

    const code = crypto.randomUUID() + crypto.randomUUID();
    await db
      .insertInto("ssh_link_codes")
      .values({
        code_hash: await sha256(code),
        fingerprint,
        public_key: publicKey,
        label,
        remote_ip: remoteIp,
        expires_at: now + sshLinkSeconds * 1000,
        consumed_at: null,
        created_at: now,
      })
      .execute();
    const oauthOrigin = new URL(githubOAuthRedirectUri(request.url, this.env.GITHUB_REDIRECT_URI))
      .origin;
    const linkUrl = new URL(`/ssh/link/${encodeURIComponent(code)}`, oauthOrigin);
    return {
      authorized: false,
      linkUrl: linkUrl.toString(),
      expiresAt: now + sshLinkSeconds * 1000,
    };
  }

  async state(request: Request): Promise<Record<string, unknown>> {
    const user = await this.requireUser(request);
    const state = await this.dependencies.readState(request, user);
    return { ...state, ssh: true };
  }

  async createSession(request: Request): Promise<{ session: InteractiveSession }> {
    const user = await this.requireUser(request);
    requireRole(user, "maintainer");
    const githubToken = await this.githubToken(request);
    if (user.subject.startsWith("github:") && !githubToken) {
      throw forbidden("GitHub credentials are not connected to this SSH key; re-link the key");
    }
    const body = await readJson<InteractiveSessionCreateRequest>(request);
    if (!normalizeRepo(body.repo)) {
      const preferred = deploymentConfig(this.env).preferredRepo;
      const repos = await database(this.env)
        .selectFrom("repos")
        .select("repo")
        .where("enabled", "=", 1)
        .orderBy("repo")
        .execute();
      const selectedRepo = preferredEnabledRepo(
        repos.map((repo) => repo.repo),
        preferred,
      );
      if (selectedRepo) body.repo = selectedRepo;
    }
    const result = await this.dependencies.createSession(user, body, githubToken);
    await this.dependencies.audit(
      user,
      `ssh interactive session created ${result.session.id}`,
      Date.now(),
    );
    return result;
  }

  async requireUser(request: Request): Promise<User> {
    this.requireGateway(request);
    const fingerprint = sshGatewayFingerprint(request);
    if (!fingerprint) throw badRequest("fingerprint is required");
    const user = await this.readUser(fingerprint);
    if (!user) throw unauthorized();
    return user;
  }

  async githubToken(request: Request): Promise<string | undefined> {
    this.requireGateway(request);
    const fingerprint = sshGatewayFingerprint(request);
    if (!fingerprint) throw badRequest("fingerprint is required");
    const user = await this.requireUser(request);
    return this.githubTokenByFingerprint(fingerprint, user.subject);
  }

  async githubTokenForRequest(request: Request, user: User): Promise<string | undefined> {
    if (!this.isRequest(request)) return undefined;
    const fingerprint = sshGatewayFingerprint(request);
    return fingerprint ? this.githubTokenByFingerprint(fingerprint, user.subject) : undefined;
  }

  isRequest(request: Request): boolean {
    const authorization = request.headers.get("authorization");
    return sshGatewayTokens(this.env).some((token) => authorization === `Bearer ${token}`);
  }

  private requireGateway(request: Request): void {
    const tokens = sshGatewayTokens(this.env);
    if (tokens.length === 0) throw serviceUnavailable("SSH gateway is not configured");
    const authorization = request.headers.get("authorization");
    if (!tokens.some((token) => authorization === `Bearer ${token}`)) throw unauthorized();
  }

  private async consumeLink(
    user: User,
    code: string,
    now: number,
    githubToken: string,
  ): Promise<void> {
    const codeHash = await sha256(code);
    const db = database(this.env);
    const row = await db
      .selectFrom("ssh_link_codes")
      .select(["fingerprint", "public_key", "label", "expires_at", "consumed_at"])
      .where("code_hash", "=", codeHash)
      .executeTakeFirst();
    if (!row || row.consumed_at || row.expires_at <= now) {
      throw badRequest("SSH link expired");
    }
    const githubTokenCiphertext = await sealSecret(this.env, githubToken);
    await executeBatch(this.env, [
      db
        .insertInto("ssh_keys")
        .values({
          fingerprint: row.fingerprint,
          subject: user.subject,
          public_key: row.public_key,
          label: row.label,
          github_token_ciphertext: githubTokenCiphertext,
          created_at: now,
          last_used_at: now,
          revoked_at: null,
        })
        .onConflict((oc) =>
          oc.column("fingerprint").doUpdateSet({
            subject: user.subject,
            public_key: row.public_key,
            label: row.label,
            github_token_ciphertext: githubTokenCiphertext,
            last_used_at: now,
            revoked_at: null,
          }),
        ),
      db.updateTable("ssh_link_codes").set({ consumed_at: now }).where("code_hash", "=", codeHash),
    ]);
    await this.dependencies.audit(user, `ssh key linked ${row.fingerprint}`, now);
  }

  private async readUser(fingerprint: string): Promise<User | null> {
    const row = await database(this.env)
      .selectFrom("ssh_keys as k")
      .innerJoin("users as u", "u.subject", "k.subject")
      .select([
        "u.subject",
        "u.login",
        "u.email",
        "u.name",
        "u.role",
        "u.allowed",
        "u.teams",
        "k.github_token_ciphertext",
      ])
      .where("k.fingerprint", "=", fingerprint)
      .where("k.revoked_at", "is", null)
      .executeTakeFirst();
    if (!row) return null;
    const user: User = {
      subject: row.subject,
      login: row.login,
      email: row.email,
      name: row.name,
      role: row.role,
      allowed: row.allowed === 1,
      teams: parseJson(row.teams, []),
    };
    if (user.subject.startsWith("github:")) {
      if (!row.github_token_ciphertext) {
        throw forbidden("SSH key needs to be re-linked with GitHub");
      }
      const githubToken = await openSecret(this.env, row.github_token_ciphertext);
      if (!githubToken) throw forbidden("SSH key GitHub credentials are unavailable");
      const freshUser = await refreshGitHubUser(this.env, githubToken).catch(() => null);
      if (!freshUser || freshUser.subject !== user.subject) {
        throw forbidden("GitHub membership refresh failed");
      }
      const authorized = await authorize(this.env, freshUser);
      if (!authorized.allowed) throw forbidden("user is no longer allowlisted");
      await upsertUser(this.env, authorized, Date.now());
      return authorized;
    }
    const authorized = await authorize(this.env, user);
    if (!authorized.allowed) throw forbidden("user is no longer allowlisted");
    return authorized;
  }

  private async githubTokenByFingerprint(
    fingerprint: string,
    subject: string,
  ): Promise<string | undefined> {
    const row = await database(this.env)
      .selectFrom("ssh_keys")
      .select("github_token_ciphertext")
      .where("fingerprint", "=", fingerprint)
      .where("subject", "=", subject)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return row?.github_token_ciphertext
      ? ((await openSecret(this.env, row.github_token_ciphertext)) ?? undefined)
      : undefined;
  }
}

export function sshGatewayFingerprint(request: Request): string {
  return clean(request.headers.get("x-crabfleet-ssh-fingerprint"), 120);
}

function sshGatewayTokens(env: RuntimeEnv): string[] {
  return [env.CRABFLEET_SSH_GATEWAY_TOKEN, env.CRABBOX_SSH_GATEWAY_TOKEN].filter(
    (token): token is string => Boolean(token),
  );
}

function sshLinkConfirmHtml(
  code: string,
  fingerprint: string,
  label: string | null,
  user: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Link SSH key - Crabfleet</title>
  <style>
    body{font:16px/1.45 system-ui,sans-serif;margin:3rem;max-width:44rem;color:#111;background:#fff}
    code{background:#f3f4f6;padding:.15rem .35rem;border-radius:.25rem;word-break:break-all}
    button{font:inherit;padding:.65rem 1rem;border:0;border-radius:.4rem;background:#111;color:#fff}
  </style>
</head>
<body>
  <h1>Link SSH key</h1>
  <p>Signed in as <strong>${htmlEscape(user)}</strong>.</p>
  <p>Fingerprint: <code>${htmlEscape(fingerprint)}</code></p>
  ${label ? `<p>Label: <code>${htmlEscape(label)}</code></p>` : ""}
  <form method="post" action="/ssh/link/${encodeURIComponent(code)}">
    <button type="submit">Link this key</button>
  </form>
</body>
</html>`;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
