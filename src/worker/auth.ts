import { developmentIdentityEnabled } from "../url-security.ts";
import {
  trustedProxyConfigured,
  type TrustedProxyAuthResult,
  type TrustedProxyIdentity,
} from "../trusted-proxy-auth.ts";
import { openSecret, sealSecret, sha256 } from "./crypto.ts";
import { database } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import { cookie, cookies, forbidden, json, readJson, unauthorized } from "./http.ts";
import type { Role, User } from "./models.ts";

const sessionCookie = "crabbox_session";
const bootstrapSessionSeconds = 60 * 60;
export const githubSessionSeconds = 60 * 15;
const roleRank: Record<Role, number> = { viewer: 1, maintainer: 2, owner: 3 };
const roleOptions = new Set<Role>(["viewer", "maintainer", "owner"]);

export async function requireUser(
  request: Request,
  env: RuntimeEnv,
  requestAuth: TrustedProxyAuthResult,
): Promise<User> {
  if (requestAuth.kind === "authenticated") {
    return requireTrustedProxyUser(env, requestAuth.identity);
  }
  if (requestAuth.kind === "missing") throw unauthorized();

  const token = cookies(request).get(sessionCookie);
  if (!token) throw unauthorized();
  const tokenHash = await sha256(token);
  const db = database(env);
  const row = await db
    .selectFrom("sessions as s")
    .innerJoin("users as u", "u.subject", "s.subject")
    .select(["u.subject", "u.login", "u.email", "u.name", "u.role", "u.allowed", "u.teams"])
    .where("s.token_hash", "=", tokenHash)
    .where("s.expires_at", ">", Date.now())
    .executeTakeFirst();
  if (!row) throw unauthorized();

  const user: User = {
    subject: row.subject,
    login: row.login,
    email: row.email,
    name: row.name,
    role: row.role,
    allowed: row.allowed === 1,
    teams: parseJson(row.teams, []),
  };

  if (user.subject.startsWith("bootstrap:")) {
    if (!env.CRABBOX_BOOTSTRAP_TOKEN || user.subject !== (await bootstrapSubject(env))) {
      await deleteSession(db, tokenHash);
      throw unauthorized();
    }
    return user;
  }

  if (user.subject.startsWith("dev:")) {
    if (!devIdentityEnabled(env, request)) {
      await deleteSession(db, tokenHash);
      throw unauthorized();
    }
    return user;
  }

  if (!user.subject.startsWith("github:")) return user;

  const authorized = await authorize(env, user);
  if (!authorized.allowed) {
    await deleteSession(db, tokenHash);
    throw forbidden("user is no longer allowlisted");
  }
  if (authorized.role !== user.role || authorized.allowed !== user.allowed) {
    await upsertUser(env, authorized, Date.now());
  }
  return authorized;
}

export async function optionalUser(
  request: Request,
  env: RuntimeEnv,
  requestAuth: TrustedProxyAuthResult,
): Promise<User | null> {
  try {
    return await requireUser(request, env, requestAuth);
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error ? Number(error.status) : 0;
    const url = new URL(request.url);
    if (
      status === 401 ||
      (status === 403 && url.pathname === "/api/terminal/ws" && url.searchParams.has("token"))
    ) {
      return null;
    }
    throw error;
  }
}

export async function authorize(env: RuntimeEnv, user: User): Promise<User> {
  const entries = await database(env)
    .selectFrom("allow_entries")
    .select(["value", "role"])
    .execute();
  const candidates = new Set([
    user.login ? `@${user.login.toLowerCase()}` : "",
    user.email ? user.email.toLowerCase() : "",
    ...user.teams.map((team) => team.toLowerCase()),
  ]);
  let role: Role | null = null;
  for (const row of entries) {
    if (!candidates.has(row.value.toLowerCase())) continue;
    role = strongerRole(role, row.role);
  }
  return { ...user, role: role ?? "viewer", allowed: role !== null };
}

export async function upsertUser(env: RuntimeEnv, user: User, now: number): Promise<void> {
  const row = {
    subject: user.subject,
    login: user.login,
    email: user.email,
    name: user.name,
    role: user.role,
    allowed: user.allowed ? 1 : 0,
    teams: JSON.stringify(user.teams),
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  };
  await database(env)
    .insertInto("users")
    .values(row)
    .onConflict((oc) =>
      oc.column("subject").doUpdateSet({
        login: row.login,
        email: row.email,
        name: row.name,
        role: row.role,
        allowed: row.allowed,
        teams: row.teams,
        updated_at: row.updated_at,
        last_seen_at: row.last_seen_at,
      }),
    )
    .execute();
}

export async function createSession(
  env: RuntimeEnv,
  request: Request,
  subject: string,
  now: number,
  maxAgeSeconds = bootstrapSessionSeconds,
  githubToken?: string,
): Promise<string> {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash = await sha256(token);
  const expires = now + maxAgeSeconds * 1000;
  const githubTokenCiphertext = githubToken ? await sealSecret(env, githubToken) : null;
  const db = database(env);
  await db.deleteFrom("sessions").where("expires_at", "<", now).execute();
  await db
    .insertInto("sessions")
    .values({
      token_hash: tokenHash,
      subject,
      expires_at: expires,
      created_at: now,
      github_token_ciphertext: githubTokenCiphertext,
    })
    .execute();
  return cookie(request, sessionCookie, token, maxAgeSeconds);
}

export async function sessionGitHubToken(
  request: Request,
  env: RuntimeEnv,
  expectedSubject: string,
): Promise<string | undefined> {
  const token = cookies(request).get(sessionCookie);
  if (!token) return undefined;
  const row = await database(env)
    .selectFrom("sessions")
    .select("github_token_ciphertext")
    .where("token_hash", "=", await sha256(token))
    .where("subject", "=", expectedSubject)
    .where("expires_at", ">", Date.now())
    .executeTakeFirst();
  return row?.github_token_ciphertext
    ? ((await openSecret(env, row.github_token_ciphertext)) ?? undefined)
    : undefined;
}

export async function logout(request: Request, env: RuntimeEnv): Promise<Response> {
  const token = cookies(request).get(sessionCookie);
  if (token) {
    await database(env)
      .deleteFrom("sessions")
      .where("token_hash", "=", await sha256(token))
      .execute();
  }
  return json({ ok: true }, { headers: { "set-cookie": cookie(request, sessionCookie, "", 0) } });
}

export async function tokenLogin(request: Request, env: RuntimeEnv): Promise<Response> {
  const { token } = await readJson<{ token?: string }>(request);
  if (!env.CRABBOX_BOOTSTRAP_TOKEN || token !== env.CRABBOX_BOOTSTRAP_TOKEN) {
    return json({ error: "invalid token" }, { status: 401 });
  }

  const now = Date.now();
  const subject = await bootstrapSubject(env);
  const user: User = {
    subject,
    login: "bootstrap",
    email: null,
    name: "Bootstrap Admin",
    role: "owner",
    allowed: true,
    teams: [],
  };
  await upsertUser(env, user, now);
  const cookieHeader = await createSession(env, request, user.subject, now);
  return json(
    { user, auth: authMethods(env, request) },
    { headers: { "set-cookie": cookieHeader } },
  );
}

export async function devIdentityLogin(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!devIdentityEnabled(env, request)) return json({ error: "not found" }, { status: 404 });

  const body = await readJson<{ id?: string; name?: string; role?: string }>(request);
  const id = devIdentityId(body.id);
  const role = parseRole(body.role);
  const user: User = {
    subject: `dev:${id}`,
    login: id,
    email: null,
    name: clean(body.name, 120) || id,
    role,
    allowed: true,
    teams: [],
  };
  const now = Date.now();
  await upsertUser(env, user, now);
  const cookieHeader = await createSession(env, request, user.subject, now);
  return json(
    { user, auth: authMethods(env, request) },
    { headers: { "set-cookie": cookieHeader } },
  );
}

export function authMethods(env: RuntimeEnv, request?: Request): Record<string, boolean> {
  return {
    github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    token: Boolean(env.CRABBOX_BOOTSTRAP_TOKEN),
    devIdentity: request ? devIdentityEnabled(env, request) : false,
    trustedProxy: trustedProxyConfigured(env),
  };
}

export function devIdentityEnabled(env: RuntimeEnv, request: Request): boolean {
  return developmentIdentityEnabled(env.CRABFLEET_DEV_LOGIN_ENABLED, request.url);
}

export function devIdentityId(value: unknown): string {
  const id = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^dev:/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return id || "dev";
}

export function parseRole(value: unknown, fallback: Role = "owner"): Role {
  return roleOptions.has(value as Role) ? (value as Role) : fallback;
}

export function requireRole(user: User, needed: Role): void {
  if (roleRank[user.role] < roleRank[needed]) throw forbidden("insufficient role");
}

export function actor(user: Pick<User, "subject" | "login" | "email">): string {
  return user.login ?? user.email ?? user.subject;
}

export async function bootstrapSubject(env: RuntimeEnv): Promise<string> {
  if (!env.CRABBOX_BOOTSTRAP_TOKEN) throw unauthorized();
  return `bootstrap:${(await sha256(env.CRABBOX_BOOTSTRAP_TOKEN)).slice(0, 24)}`;
}

async function requireTrustedProxyUser(
  env: RuntimeEnv,
  identity: TrustedProxyIdentity,
): Promise<User> {
  const user = await authorize(env, {
    subject: identity.subject,
    login: identity.login,
    email: identity.email,
    name: identity.name,
    role: "viewer",
    allowed: false,
    teams: [],
  });
  if (!user.allowed) throw forbidden("trusted proxy user is not allowlisted");

  const existing = await database(env)
    .selectFrom("users")
    .select(["login", "email", "name", "role", "allowed"])
    .where("subject", "=", user.subject)
    .executeTakeFirst();
  if (
    !existing ||
    existing.login !== user.login ||
    existing.email !== user.email ||
    existing.name !== user.name ||
    existing.role !== user.role ||
    existing.allowed !== 1
  ) {
    await upsertUser(env, user, Date.now());
  }
  return user;
}

function strongerRole(left: Role | null, right: Role): Role {
  if (!left) return right;
  return roleRank[right] > roleRank[left] ? right : left;
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

async function deleteSession(db: ReturnType<typeof database>, tokenHash: string): Promise<void> {
  await db.deleteFrom("sessions").where("token_hash", "=", tokenHash).execute();
}
