import { sql } from "kysely";

import { sha256, openSecret, sealSecret } from "./crypto.ts";
import { database, executeBatch } from "./database.ts";
import { browserAppOrigin } from "./deployment.ts";
import type { RuntimeEnv } from "./env.ts";
import {
  GitHubApiError,
  refreshGitHubUserWithEvidence,
  type GitHubUserRefreshEvidence,
} from "./github.ts";
import {
  badRequest,
  bearerToken,
  forbidden,
  serviceUnavailable,
  tooManyRequests,
  unauthorized,
} from "./http.ts";
import type { User } from "./models.ts";
import { reauthorizeStoredUser } from "./auth.ts";

export const nativeDeviceAuthorizationSeconds = 10 * 60;
export const nativeAccessTokenSeconds = 24 * 60 * 60;
export const nativePollIntervalSeconds = 5;
export const nativeAccessScope = "fleet:read";

const nativeDeviceAttemptsPerAddress = 20;
const nativeDeviceAttemptsWithoutAddress = 100;

export type NativeDeviceAuthorizationRecord = {
  deviceCodeHash: string;
  linkCodeHash: string;
  clientName: string;
  remoteIp: string | null;
  subject: string | null;
  accessTokenHash: string | null;
  accessTokenCiphertext: string | null;
  accessTokenExpiresAt: number | null;
  expiresAt: number;
  nextPollAt: number;
  approvedAt: number | null;
  consumedAt: number | null;
  createdAt: number;
};

export type NativeAccessTokenRecord = {
  tokenHash: string;
  scope: string;
  expiresAt: number;
  githubTokenCiphertext: string | null;
  user: User;
};

export type NativeDeviceStartResult = {
  deviceCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSeconds: number;
};

export type NativeTokenPollResult =
  | { kind: "pending"; intervalSeconds: number }
  | { kind: "slow_down"; intervalSeconds: number }
  | {
      kind: "authorized";
      accessToken: string;
      expiresAt: number;
      user: User;
    };

export type NativeAuthStore = {
  prune(now: number): Promise<void>;
  recentDeviceCount(remoteIp: string | null, since: number): Promise<number>;
  createDevice(
    record: NativeDeviceAuthorizationRecord,
    since: number,
    limit: number,
  ): Promise<boolean>;
  readDeviceByLinkCode(linkCodeHash: string): Promise<NativeDeviceAuthorizationRecord | null>;
  readDeviceByDeviceCode(deviceCodeHash: string): Promise<NativeDeviceAuthorizationRecord | null>;
  approveDevice(input: {
    linkCodeHash: string;
    subject: string;
    accessTokenHash: string;
    accessTokenCiphertext: string;
    accessTokenExpiresAt: number;
    githubTokenCiphertext: string | null;
    clientName: string;
    now: number;
  }): Promise<boolean>;
  reservePendingPoll(deviceCodeHash: string, now: number, nextPollAt: number): Promise<boolean>;
  consumeDevice(deviceCodeHash: string, now: number): Promise<boolean>;
  readAccessToken(tokenHash: string, now: number): Promise<NativeAccessTokenRecord | null>;
  touchAccessToken(tokenHash: string, now: number): Promise<void>;
  revokeAccessToken(tokenHash: string, now: number): Promise<void>;
};

export type NativeAuthServiceDependencies = {
  store: NativeAuthStore;
  now(): number;
  randomSecret(): string;
  seal(value: string): Promise<string | null>;
  open(value: string): Promise<string | null>;
  refreshGitHubUser(token: string): Promise<GitHubUserRefreshEvidence>;
  reauthorize(user: User): Promise<User>;
  publicOrigin: string;
};

export class NativeAuthService {
  private readonly dependencies: NativeAuthServiceDependencies;

  constructor(dependencies: NativeAuthServiceDependencies) {
    this.dependencies = dependencies;
  }

  async start(clientNameValue: unknown, remoteIpValue: unknown): Promise<NativeDeviceStartResult> {
    const clientName = cleanClientName(clientNameValue);
    if (!clientName) throw badRequest("clientName is required");
    const remoteIp = clean(remoteIpValue, 120) || null;
    const now = this.dependencies.now();
    const recent = await this.dependencies.store.recentDeviceCount(
      remoteIp,
      now - nativeDeviceAuthorizationSeconds * 1000,
    );
    const limit = remoteIp ? nativeDeviceAttemptsPerAddress : nativeDeviceAttemptsWithoutAddress;
    if (recent >= limit) throw tooManyRequests("too many native authorization attempts");

    const deviceCode = this.dependencies.randomSecret();
    const linkCode = this.dependencies.randomSecret();
    const expiresAt = now + nativeDeviceAuthorizationSeconds * 1000;
    const record = {
      deviceCodeHash: await sha256(deviceCode),
      linkCodeHash: await sha256(linkCode),
      clientName,
      remoteIp,
      subject: null,
      accessTokenHash: null,
      accessTokenCiphertext: null,
      accessTokenExpiresAt: null,
      expiresAt,
      nextPollAt: now + nativePollIntervalSeconds * 1000,
      approvedAt: null,
      consumedAt: null,
      createdAt: now,
    } satisfies NativeDeviceAuthorizationRecord;
    if (
      !(await this.dependencies.store.createDevice(
        record,
        now - nativeDeviceAuthorizationSeconds * 1000,
        limit,
      ))
    ) {
      throw tooManyRequests("too many native authorization attempts");
    }
    return {
      deviceCode,
      verificationUri: new URL(
        `/native/link/${encodeURIComponent(linkCode)}`,
        this.dependencies.publicOrigin,
      ).toString(),
      expiresAt,
      intervalSeconds: nativePollIntervalSeconds,
    };
  }

  async link(code: string): Promise<NativeDeviceAuthorizationRecord> {
    const normalized = validSecret(code);
    if (!normalized) throw unauthorized();
    const record = await this.dependencies.store.readDeviceByLinkCode(await sha256(normalized));
    if (!record || record.expiresAt <= this.dependencies.now()) throw unauthorized();
    return record;
  }

  async approve(code: string, user: User, githubToken?: string): Promise<{ clientName: string }> {
    const record = await this.link(code);
    if (record.approvedAt || record.consumedAt)
      throw badRequest("native authorization is no longer pending");
    if (user.subject.startsWith("github:") && !githubToken) {
      throw forbidden("GitHub credentials are required for native authorization");
    }

    const accessToken = this.dependencies.randomSecret();
    const accessTokenHash = await sha256(accessToken);
    const accessTokenCiphertext = await this.dependencies.seal(accessToken);
    if (!accessTokenCiphertext) {
      throw serviceUnavailable("native token encryption is not configured");
    }
    const githubTokenCiphertext = githubToken ? await this.dependencies.seal(githubToken) : null;
    if (githubToken && !githubTokenCiphertext) {
      throw serviceUnavailable("native GitHub credential encryption is not configured");
    }
    const now = this.dependencies.now();
    const accessTokenExpiresAt = now + nativeAccessTokenSeconds * 1000;
    const approved = await this.dependencies.store.approveDevice({
      linkCodeHash: record.linkCodeHash,
      subject: user.subject,
      accessTokenHash,
      accessTokenCiphertext,
      accessTokenExpiresAt,
      githubTokenCiphertext,
      clientName: record.clientName,
      now,
    });
    if (!approved) throw badRequest("native authorization is no longer pending");
    return { clientName: record.clientName };
  }

  async poll(deviceCodeValue: unknown): Promise<NativeTokenPollResult> {
    const deviceCode = validSecret(deviceCodeValue);
    if (!deviceCode) throw unauthorized();
    const deviceCodeHash = await sha256(deviceCode);
    const now = this.dependencies.now();
    const record = await this.dependencies.store.readDeviceByDeviceCode(deviceCodeHash);
    if (!record || record.expiresAt <= now || record.consumedAt) throw unauthorized();

    if (!record.approvedAt) {
      if (record.nextPollAt > now) {
        return { kind: "slow_down", intervalSeconds: nativePollIntervalSeconds };
      }
      const reserved = await this.dependencies.store.reservePendingPoll(
        deviceCodeHash,
        now,
        now + nativePollIntervalSeconds * 1000,
      );
      return reserved
        ? { kind: "pending", intervalSeconds: nativePollIntervalSeconds }
        : { kind: "slow_down", intervalSeconds: nativePollIntervalSeconds };
    }

    if (
      !record.subject ||
      !record.accessTokenHash ||
      !record.accessTokenCiphertext ||
      !record.accessTokenExpiresAt ||
      record.accessTokenExpiresAt <= now
    ) {
      throw unauthorized();
    }
    const access = await this.dependencies.store.readAccessToken(record.accessTokenHash, now);
    if (!access || access.user.subject !== record.subject) throw unauthorized();
    const user = await this.currentAccessUser(access, now);
    const accessToken = await this.dependencies.open(record.accessTokenCiphertext);
    if (!accessToken || (await sha256(accessToken)) !== record.accessTokenHash) {
      throw serviceUnavailable("native token handoff is unavailable");
    }
    if (!(await this.dependencies.store.consumeDevice(deviceCodeHash, now))) throw unauthorized();
    return {
      kind: "authorized",
      accessToken,
      expiresAt: record.accessTokenExpiresAt,
      user,
    };
  }

  async authenticate(request: Request): Promise<User> {
    const now = this.dependencies.now();
    const { tokenHash, record } = await this.localAccess(request, now);
    const user = await this.currentAccessUser(record, now);
    await this.dependencies.store.touchAccessToken(tokenHash, now);
    return user;
  }

  async revoke(request: Request): Promise<void> {
    const now = this.dependencies.now();
    const { tokenHash } = await this.localAccess(request, now);
    await this.dependencies.store.revokeAccessToken(tokenHash, now);
  }

  async pruneExpired(now = this.dependencies.now()): Promise<void> {
    await this.dependencies.store.prune(now);
  }

  private async localAccess(
    request: Request,
    now: number,
  ): Promise<{ tokenHash: string; record: NativeAccessTokenRecord }> {
    const token = validSecret(bearerToken(request));
    if (!token) throw unauthorized();
    const tokenHash = await sha256(token);
    const record = await this.dependencies.store.readAccessToken(tokenHash, now);
    if (!record || record.scope !== nativeAccessScope) throw unauthorized();
    return { tokenHash, record };
  }

  private async currentAccessUser(record: NativeAccessTokenRecord, now: number): Promise<User> {
    let candidate = record.user;
    let emailLookupComplete = true;
    if (candidate.subject.startsWith("github:")) {
      if (!record.githubTokenCiphertext) {
        await this.dependencies.store.revokeAccessToken(record.tokenHash, now);
        throw unauthorized();
      }
      const githubToken = await this.dependencies.open(record.githubTokenCiphertext);
      if (!githubToken) {
        throw serviceUnavailable("native GitHub credentials are unavailable");
      }
      let refresh: GitHubUserRefreshEvidence;
      try {
        refresh = await this.dependencies.refreshGitHubUser(githubToken);
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 401) {
          await this.dependencies.store.revokeAccessToken(record.tokenHash, now);
          throw unauthorized();
        }
        throw serviceUnavailable("GitHub membership refresh failed; retry later");
      }
      const fresh = refresh.user;
      if (!fresh || fresh.subject !== candidate.subject) {
        await this.dependencies.store.revokeAccessToken(record.tokenHash, now);
        throw unauthorized();
      }
      candidate = fresh;
      emailLookupComplete = refresh.emailLookupComplete;
    }
    try {
      return await this.dependencies.reauthorize(candidate);
    } catch (error) {
      if (httpStatus(error) !== 403) throw error;
      if (!emailLookupComplete) {
        throw serviceUnavailable("GitHub email refresh failed; retry later");
      }
      await this.dependencies.store.revokeAccessToken(record.tokenHash, now);
      throw unauthorized();
    }
  }
}

export function createNativeAuthService(env: RuntimeEnv): NativeAuthService {
  return new NativeAuthService({
    store: new D1NativeAuthStore(env),
    now: Date.now,
    randomSecret: () => crypto.randomUUID() + crypto.randomUUID(),
    seal: (value) => sealSecret(env, value),
    open: (value) => openSecret(env, value),
    refreshGitHubUser: (token) => refreshGitHubUserWithEvidence(env, token),
    reauthorize: (user) => reauthorizeStoredUser(env, user),
    publicOrigin: browserAppOrigin(env),
  });
}

class D1NativeAuthStore implements NativeAuthStore {
  private readonly env: RuntimeEnv;

  constructor(env: RuntimeEnv) {
    this.env = env;
  }

  async prune(now: number): Promise<void> {
    const db = database(this.env);
    await executeBatch(this.env, [
      sql`
        DELETE FROM native_access_tokens
        WHERE token_hash IN (
          SELECT access_token_hash
          FROM native_device_authorizations
          WHERE expires_at <= ${now}
            AND consumed_at IS NULL
            AND access_token_hash IS NOT NULL
        )
      `,
      db.deleteFrom("native_device_authorizations").where("expires_at", "<=", now),
      db.deleteFrom("native_access_tokens").where("expires_at", "<=", now),
    ]);
  }

  async recentDeviceCount(remoteIp: string | null, since: number): Promise<number> {
    let query = database(this.env)
      .selectFrom("native_device_authorizations")
      .select((expression) => expression.fn.count<number>("device_code_hash").as("count"))
      .where("created_at", ">", since);
    query = remoteIp
      ? query.where("remote_ip", "=", remoteIp)
      : query.where("remote_ip", "is", null);
    return (await query.executeTakeFirst())?.count ?? 0;
  }

  async createDevice(
    record: NativeDeviceAuthorizationRecord,
    since: number,
    limit: number,
  ): Promise<boolean> {
    const db = database(this.env);
    const remotePredicate = record.remoteIp
      ? sql`remote_ip = ${record.remoteIp}`
      : sql`remote_ip IS NULL`;
    await sql`
      INSERT INTO native_device_authorizations
        (device_code_hash, link_code_hash, client_name, remote_ip, subject,
         access_token_hash, access_token_ciphertext, access_token_expires_at,
         expires_at, next_poll_at, approved_at, consumed_at, created_at)
      SELECT
        ${record.deviceCodeHash}, ${record.linkCodeHash}, ${record.clientName}, ${record.remoteIp},
        NULL, NULL, NULL, NULL, ${record.expiresAt}, ${record.nextPollAt}, NULL, NULL,
        ${record.createdAt}
      WHERE (
        SELECT count(*)
        FROM native_device_authorizations
        WHERE created_at > ${since} AND ${remotePredicate}
      ) < ${limit}
    `.execute(db);
    return Boolean(
      await db
        .selectFrom("native_device_authorizations")
        .select("device_code_hash")
        .where("device_code_hash", "=", record.deviceCodeHash)
        .executeTakeFirst(),
    );
  }

  async readDeviceByLinkCode(
    linkCodeHash: string,
  ): Promise<NativeDeviceAuthorizationRecord | null> {
    const row = await database(this.env)
      .selectFrom("native_device_authorizations")
      .selectAll()
      .where("link_code_hash", "=", linkCodeHash)
      .executeTakeFirst();
    return row ? deviceRecord(row) : null;
  }

  async readDeviceByDeviceCode(
    deviceCodeHash: string,
  ): Promise<NativeDeviceAuthorizationRecord | null> {
    const row = await database(this.env)
      .selectFrom("native_device_authorizations")
      .selectAll()
      .where("device_code_hash", "=", deviceCodeHash)
      .executeTakeFirst();
    return row ? deviceRecord(row) : null;
  }

  async approveDevice(input: {
    linkCodeHash: string;
    subject: string;
    accessTokenHash: string;
    accessTokenCiphertext: string;
    accessTokenExpiresAt: number;
    githubTokenCiphertext: string | null;
    clientName: string;
    now: number;
  }): Promise<boolean> {
    const db = database(this.env);
    await executeBatch(this.env, [
      sql`
        INSERT INTO native_access_tokens
          (token_hash, subject, scope, client_name, github_token_ciphertext,
           expires_at, created_at, last_used_at, revoked_at)
        SELECT
          ${input.accessTokenHash}, ${input.subject}, ${nativeAccessScope}, ${input.clientName},
          ${input.githubTokenCiphertext}, ${input.accessTokenExpiresAt}, ${input.now}, ${input.now},
          NULL
        FROM native_device_authorizations
        WHERE link_code_hash = ${input.linkCodeHash}
          AND expires_at > ${input.now}
          AND approved_at IS NULL
          AND consumed_at IS NULL
      `,
      db
        .updateTable("native_device_authorizations")
        .set({
          subject: input.subject,
          access_token_hash: input.accessTokenHash,
          access_token_ciphertext: input.accessTokenCiphertext,
          access_token_expires_at: input.accessTokenExpiresAt,
          approved_at: input.now,
        })
        .where("link_code_hash", "=", input.linkCodeHash)
        .where("expires_at", ">", input.now)
        .where("approved_at", "is", null)
        .where("consumed_at", "is", null),
    ]);
    const approved = await db
      .selectFrom("native_device_authorizations")
      .select("access_token_hash")
      .where("link_code_hash", "=", input.linkCodeHash)
      .executeTakeFirst();
    return approved?.access_token_hash === input.accessTokenHash;
  }

  async reservePendingPoll(
    deviceCodeHash: string,
    now: number,
    nextPollAt: number,
  ): Promise<boolean> {
    const result = await database(this.env)
      .updateTable("native_device_authorizations")
      .set({ next_poll_at: nextPollAt })
      .where("device_code_hash", "=", deviceCodeHash)
      .where("expires_at", ">", now)
      .where("approved_at", "is", null)
      .where("consumed_at", "is", null)
      .where("next_poll_at", "<=", now)
      .executeTakeFirst();
    return (result.numUpdatedRows ?? 0n) === 1n;
  }

  async consumeDevice(deviceCodeHash: string, now: number): Promise<boolean> {
    const result = await database(this.env)
      .updateTable("native_device_authorizations")
      .set({ consumed_at: now, access_token_ciphertext: null })
      .where("device_code_hash", "=", deviceCodeHash)
      .where("expires_at", ">", now)
      .where("approved_at", "is not", null)
      .where("consumed_at", "is", null)
      .where("access_token_ciphertext", "is not", null)
      .executeTakeFirst();
    return (result.numUpdatedRows ?? 0n) === 1n;
  }

  async readAccessToken(tokenHash: string, now: number): Promise<NativeAccessTokenRecord | null> {
    const row = await database(this.env)
      .selectFrom("native_access_tokens as t")
      .innerJoin("users as u", "u.subject", "t.subject")
      .select([
        "t.token_hash",
        "t.scope",
        "t.expires_at",
        "t.github_token_ciphertext",
        "u.subject",
        "u.login",
        "u.email",
        "u.name",
        "u.role",
        "u.allowed",
        "u.teams",
      ])
      .where("t.token_hash", "=", tokenHash)
      .where("t.expires_at", ">", now)
      .where("t.revoked_at", "is", null)
      .executeTakeFirst();
    return row
      ? {
          tokenHash: row.token_hash,
          scope: row.scope,
          expiresAt: row.expires_at,
          githubTokenCiphertext: row.github_token_ciphertext,
          user: userFromRow(row),
        }
      : null;
  }

  async touchAccessToken(tokenHash: string, now: number): Promise<void> {
    await database(this.env)
      .updateTable("native_access_tokens")
      .set({ last_used_at: now })
      .where("token_hash", "=", tokenHash)
      .where("expires_at", ">", now)
      .where("revoked_at", "is", null)
      .execute();
  }

  async revokeAccessToken(tokenHash: string, now: number): Promise<void> {
    await database(this.env)
      .updateTable("native_access_tokens")
      .set({ revoked_at: now, github_token_ciphertext: null })
      .where("token_hash", "=", tokenHash)
      .where("revoked_at", "is", null)
      .execute();
  }
}

function deviceRow(record: NativeDeviceAuthorizationRecord) {
  return {
    device_code_hash: record.deviceCodeHash,
    link_code_hash: record.linkCodeHash,
    client_name: record.clientName,
    remote_ip: record.remoteIp,
    subject: record.subject,
    access_token_hash: record.accessTokenHash,
    access_token_ciphertext: record.accessTokenCiphertext,
    access_token_expires_at: record.accessTokenExpiresAt,
    expires_at: record.expiresAt,
    next_poll_at: record.nextPollAt,
    approved_at: record.approvedAt,
    consumed_at: record.consumedAt,
    created_at: record.createdAt,
  };
}

function deviceRecord(row: ReturnType<typeof deviceRow>): NativeDeviceAuthorizationRecord {
  return {
    deviceCodeHash: row.device_code_hash,
    linkCodeHash: row.link_code_hash,
    clientName: row.client_name,
    remoteIp: row.remote_ip,
    subject: row.subject,
    accessTokenHash: row.access_token_hash,
    accessTokenCiphertext: row.access_token_ciphertext,
    accessTokenExpiresAt: row.access_token_expires_at,
    expiresAt: row.expires_at,
    nextPollAt: row.next_poll_at,
    approvedAt: row.approved_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

function userFromRow(row: {
  subject: string;
  login: string | null;
  email: string | null;
  name: string | null;
  role: User["role"];
  allowed: number;
  teams: string;
}): User {
  return {
    subject: row.subject,
    login: row.login,
    email: row.email,
    name: row.name,
    role: row.role,
    allowed: row.allowed === 1,
    teams: parseJson(row.teams, []),
  };
}

function cleanClientName(value: unknown): string {
  if (typeof value !== "string") return "";
  let result = "";
  for (const character of clean(value, 120)) {
    const codePoint = character.codePointAt(0) ?? 0;
    result += codePoint <= 31 || codePoint === 127 ? " " : character;
  }
  return result.replace(/\s+/gu, " ").trim();
}

function validSecret(value: unknown): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 200 || /\s/u.test(value)) {
    return "";
  }
  return value;
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function httpStatus(error: unknown): number | undefined {
  return typeof error === "object" && error && "status" in error ? Number(error.status) : undefined;
}
