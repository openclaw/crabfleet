import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../src/worker/crypto.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import { GitHubApiError, type GitHubUserRefreshEvidence } from "../src/worker/github.ts";
import type { User } from "../src/worker/models.ts";
import {
  NativeAuthService,
  createNativeAuthService,
  nativeAccessScope,
  nativeAccessTokenSeconds,
  nativeDeviceAuthorizationSeconds,
  nativePollIntervalSeconds,
  type NativeAccessTokenRecord,
  type NativeAuthStore,
  type NativeDeviceAuthorizationRecord,
} from "../src/worker/native-auth.ts";

const viewer: User = {
  subject: "github:1",
  login: "viewer",
  email: "viewer@example.com",
  name: "Viewer",
  role: "viewer",
  allowed: true,
  teams: ["@example/core"],
};

type AccessRow = NativeAccessTokenRecord & { revokedAt: number | null; lastUsedAt: number };

class MemoryNativeAuthStore implements NativeAuthStore {
  devices = new Map<string, NativeDeviceAuthorizationRecord>();
  access = new Map<string, AccessRow>();
  users = new Map([[viewer.subject, viewer]]);

  async prune(now: number): Promise<void> {
    for (const [key, record] of this.devices) {
      if (record.expiresAt > now) continue;
      if (record.consumedAt === null && record.accessTokenHash) {
        this.access.delete(record.accessTokenHash);
      }
      this.devices.delete(key);
    }
    for (const [key, record] of this.access) {
      if (record.expiresAt <= now) this.access.delete(key);
    }
  }

  async recentDeviceCount(remoteIp: string | null, since: number): Promise<number> {
    return [...this.devices.values()].filter(
      (record) => record.remoteIp === remoteIp && record.createdAt > since,
    ).length;
  }

  async createDevice(
    record: NativeDeviceAuthorizationRecord,
    since: number,
    limit: number,
  ): Promise<boolean> {
    if ((await this.recentDeviceCount(record.remoteIp, since)) >= limit) return false;
    this.devices.set(record.deviceCodeHash, { ...record });
    return true;
  }

  async readDeviceByLinkCode(linkCodeHash: string) {
    return (
      [...this.devices.values()].find((record) => record.linkCodeHash === linkCodeHash) ?? null
    );
  }

  async readDeviceByDeviceCode(deviceCodeHash: string) {
    return this.devices.get(deviceCodeHash) ?? null;
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
    const record = await this.readDeviceByLinkCode(input.linkCodeHash);
    if (!record || record.approvedAt || record.consumedAt || record.expiresAt <= input.now) {
      return false;
    }
    const user = this.users.get(input.subject);
    if (!user) return false;
    Object.assign(record, {
      subject: input.subject,
      accessTokenHash: input.accessTokenHash,
      accessTokenCiphertext: input.accessTokenCiphertext,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      approvedAt: input.now,
    });
    this.access.set(input.accessTokenHash, {
      tokenHash: input.accessTokenHash,
      scope: nativeAccessScope,
      expiresAt: input.accessTokenExpiresAt,
      githubTokenCiphertext: input.githubTokenCiphertext,
      user,
      revokedAt: null,
      lastUsedAt: input.now,
    });
    return true;
  }

  async reservePendingPoll(deviceCodeHash: string, now: number, nextPollAt: number) {
    const record = this.devices.get(deviceCodeHash);
    if (
      !record ||
      record.approvedAt ||
      record.consumedAt ||
      record.expiresAt <= now ||
      record.nextPollAt > now
    ) {
      return false;
    }
    record.nextPollAt = nextPollAt;
    return true;
  }

  async consumeDevice(deviceCodeHash: string, now: number) {
    const record = this.devices.get(deviceCodeHash);
    if (
      !record ||
      !record.approvedAt ||
      record.consumedAt ||
      !record.accessTokenCiphertext ||
      record.expiresAt <= now
    ) {
      return false;
    }
    record.consumedAt = now;
    record.accessTokenCiphertext = null;
    return true;
  }

  async readUser(subject: string) {
    return this.users.get(subject) ?? null;
  }

  async readAccessToken(tokenHash: string, now: number) {
    const record = this.access.get(tokenHash);
    return record && !record.revokedAt && record.expiresAt > now ? record : null;
  }

  async touchAccessToken(tokenHash: string, now: number) {
    const record = this.access.get(tokenHash);
    if (record) record.lastUsedAt = now;
  }

  async revokeAccessToken(tokenHash: string, now: number) {
    const record = this.access.get(tokenHash);
    if (record && !record.revokedAt) {
      record.revokedAt = now;
      record.githubTokenCiphertext = null;
    }
  }
}

function harness(
  options: {
    now?: number;
    reauthorize?: (user: User) => Promise<User>;
    refreshGitHubUser?: (token: string) => Promise<User | null>;
    refreshGitHubUserEvidence?: (token: string) => Promise<GitHubUserRefreshEvidence>;
  } = {},
) {
  let now = options.now ?? 1_000;
  const store = new MemoryNativeAuthStore();
  const secrets = [
    `device-${"d".repeat(48)}`,
    `link-${"l".repeat(48)}`,
    `access-${"a".repeat(48)}`,
  ];
  const sealed = new Map<string, string>();
  const service = new NativeAuthService({
    store,
    now: () => now,
    randomSecret: () => {
      const value = secrets.shift();
      assert.ok(value);
      return value;
    },
    async seal(value) {
      const ciphertext = `ciphertext-${sealed.size + 1}`;
      sealed.set(ciphertext, value);
      return ciphertext;
    },
    async open(value) {
      return sealed.get(value) ?? null;
    },
    refreshGitHubUser:
      options.refreshGitHubUserEvidence ??
      (async (token) => ({
        user: await (options.refreshGitHubUser ?? (async () => viewer))(token),
        emailLookupComplete: true,
      })),
    reauthorize: options.reauthorize ?? (async (user) => user),
    publicOrigin: "https://fleet.example",
  });
  return {
    service,
    store,
    secrets,
    setNow(value: number) {
      now = value;
    },
    now() {
      return now;
    },
  };
}

test("native device start stores only hashes, uses the public origin, and rate limits", async () => {
  const subject = harness();
  let pruneCalls = 0;
  subject.store.prune = async () => {
    pruneCalls += 1;
  };
  const result = await subject.service.start(" Peter's Mac\n ", "192.0.2.1");
  assert.equal(result.deviceCode, `device-${"d".repeat(48)}`);
  assert.equal(result.verificationUri, `https://fleet.example/native/link/link-${"l".repeat(48)}`);
  assert.equal(result.expiresAt, 1_000 + nativeDeviceAuthorizationSeconds * 1000);
  assert.equal(result.intervalSeconds, nativePollIntervalSeconds);

  const record = subject.store.devices.get(await sha256(result.deviceCode));
  assert.ok(record);
  assert.equal(record.clientName, "Peter's Mac");
  assert.equal(record.linkCodeHash, await sha256(`link-${"l".repeat(48)}`));
  assert.equal(JSON.stringify(record).includes(result.deviceCode), false);
  assert.equal(JSON.stringify(record).includes(`link-${"l".repeat(48)}`), false);
  assert.equal(pruneCalls, 0);

  subject.store.recentDeviceCount = async () => 20;
  await assert.rejects(subject.service.start("Another Mac", "192.0.2.1"), (error) => {
    assert.equal(httpStatus(error), 429);
    return true;
  });
  assert.equal(pruneCalls, 0);

  const raced = harness();
  raced.store.recentDeviceCount = async () => 0;
  raced.store.createDevice = async () => false;
  await assert.rejects(raced.service.start("Racing Mac", "192.0.2.1"), (error) => {
    assert.equal(httpStatus(error), 429);
    return true;
  });

  const invalid = harness();
  for (const clientName of ["\u0000\n", 42, { name: "Mac" }]) {
    await assert.rejects(invalid.service.start(clientName, "192.0.2.1"), hasStatus(400));
  }
});

test("native polling is paced and approval exchanges an encrypted token exactly once", async () => {
  const subject = harness();
  const started = await subject.service.start("Peter's Mac", "192.0.2.1");
  assert.deepEqual(await subject.service.poll(started.deviceCode), {
    kind: "slow_down",
    intervalSeconds: 5,
  });

  subject.setNow(subject.now() + nativePollIntervalSeconds * 1000);
  assert.deepEqual(await subject.service.poll(started.deviceCode), {
    kind: "pending",
    intervalSeconds: 5,
  });
  assert.deepEqual(await subject.service.poll(started.deviceCode), {
    kind: "slow_down",
    intervalSeconds: 5,
  });

  const linkCode = decodeURIComponent(new URL(started.verificationUri).pathname.split("/").at(-1)!);
  await assert.rejects(subject.service.approve(linkCode, viewer), (error) => {
    assert.equal(httpStatus(error), 403);
    return true;
  });
  await subject.service.approve(linkCode, viewer, "github-token");
  await assert.rejects(subject.service.approve(linkCode, viewer, "github-token"), (error) => {
    assert.equal(httpStatus(error), 400);
    return true;
  });

  const exchanged = await subject.service.poll(started.deviceCode);
  assert.equal(exchanged.kind, "authorized");
  if (exchanged.kind !== "authorized") return;
  assert.equal(exchanged.accessToken, `access-${"a".repeat(48)}`);
  assert.equal(exchanged.expiresAt, subject.now() + nativeAccessTokenSeconds * 1000);
  const tokenHash = await sha256(exchanged.accessToken);
  const access = subject.store.access.get(tokenHash);
  assert.equal(access?.scope, nativeAccessScope);
  assert.ok(access?.githubTokenCiphertext);
  assert.equal(access?.githubTokenCiphertext?.includes("github-token"), false);
  assert.equal(JSON.stringify(access).includes(exchanged.accessToken), false);
  assert.equal(
    (await subject.store.readDeviceByDeviceCode(await sha256(started.deviceCode)))
      ?.accessTokenCiphertext,
    null,
  );

  await assert.rejects(subject.service.poll(started.deviceCode), (error) => {
    assert.equal(httpStatus(error), 401);
    return true;
  });
});

test("native bearer access enforces scope, expiry, revoke, and current authorization", async () => {
  let denyCurrentAuthorization = false;
  const subject = harness({
    async reauthorize(user) {
      if (denyCurrentAuthorization) {
        throw Object.assign(new Error("no longer allowlisted"), { status: 403 });
      }
      return user;
    },
  });
  const started = await subject.service.start("Peter's Mac", "192.0.2.1");
  const linkCode = decodeURIComponent(new URL(started.verificationUri).pathname.split("/").at(-1)!);
  await subject.service.approve(linkCode, viewer, "github-token");
  const exchanged = await subject.service.poll(started.deviceCode);
  assert.equal(exchanged.kind, "authorized");
  if (exchanged.kind !== "authorized") return;
  const request = new Request("https://fleet.example/api/native/v1/fleet", {
    headers: { authorization: `Bearer ${exchanged.accessToken}` },
  });
  assert.deepEqual(await subject.service.authenticate(request), viewer);

  const tokenHash = await sha256(exchanged.accessToken);
  const access = subject.store.access.get(tokenHash);
  assert.ok(access);
  const githubTokenCiphertext = access.githubTokenCiphertext;
  assert.ok(githubTokenCiphertext);
  access.scope = "other";
  await assert.rejects(subject.service.authenticate(request), hasStatus(401));
  access.scope = nativeAccessScope;

  await subject.service.revoke(request);
  await assert.rejects(subject.service.authenticate(request), hasStatus(401));

  access.revokedAt = null;
  access.githubTokenCiphertext = githubTokenCiphertext;
  access.expiresAt = subject.now();
  await assert.rejects(subject.service.authenticate(request), hasStatus(401));

  access.expiresAt = subject.now() + 1_000;
  denyCurrentAuthorization = true;
  await assert.rejects(subject.service.authenticate(request), hasStatus(401));
  assert.equal(subject.store.access.get(tokenHash)?.revokedAt, subject.now());
});

test("GitHub native access refreshes membership and distinguishes transient from actual denial", async () => {
  let refresh: "active" | "transient" | "invalid" | "inactive" | "mismatch" = "active";
  const refreshed = { ...viewer, teams: ["@example/current"] };
  let reauthorized: User | null = null;
  const subject = harness({
    async refreshGitHubUser(token) {
      assert.equal(token, "github-token");
      if (refresh === "transient") throw new Error("GitHub unavailable");
      if (refresh === "invalid") throw new GitHubApiError(401);
      if (refresh === "inactive") return null;
      if (refresh === "mismatch") return { ...refreshed, subject: "github:other" };
      return refreshed;
    },
    async reauthorize(user) {
      reauthorized = user;
      return user;
    },
  });
  const started = await subject.service.start("Peter's Mac", "192.0.2.1");
  const linkCode = decodeURIComponent(new URL(started.verificationUri).pathname.split("/").at(-1)!);
  await subject.service.approve(linkCode, viewer, "github-token");
  const exchanged = await subject.service.poll(started.deviceCode);
  assert.equal(exchanged.kind, "authorized");
  assert.deepEqual(reauthorized, refreshed);
  if (exchanged.kind !== "authorized") return;
  const request = new Request("https://fleet.example/api/native/v1/fleet", {
    headers: { authorization: `Bearer ${exchanged.accessToken}` },
  });
  const tokenHash = await sha256(exchanged.accessToken);
  const githubTokenCiphertext = subject.store.access.get(tokenHash)?.githubTokenCiphertext;
  assert.ok(githubTokenCiphertext);

  refresh = "transient";
  await assert.rejects(subject.service.authenticate(request), hasStatus(503));
  assert.equal(subject.store.access.get(tokenHash)?.revokedAt, null);
  assert.ok(subject.store.access.get(tokenHash)?.githubTokenCiphertext);

  refresh = "invalid";
  await assert.rejects(subject.service.authenticate(request), hasStatus(401));
  assert.equal(subject.store.access.get(tokenHash)?.revokedAt, subject.now());
  assert.equal(subject.store.access.get(tokenHash)?.githubTokenCiphertext, null);

  subject.store.access.get(tokenHash)!.revokedAt = null;
  subject.store.access.get(tokenHash)!.githubTokenCiphertext = githubTokenCiphertext;
  refresh = "inactive";
  await assert.rejects(subject.service.authenticate(request), hasStatus(401));
  assert.equal(subject.store.access.get(tokenHash)?.revokedAt, subject.now());
  assert.equal(subject.store.access.get(tokenHash)?.githubTokenCiphertext, null);

  const mismatched = harness({
    refreshGitHubUser: async () => ({ ...viewer, subject: "github:other" }),
  });
  const mismatchStart = await mismatched.service.start("Other Mac", "192.0.2.2");
  const mismatchLink = decodeURIComponent(
    new URL(mismatchStart.verificationUri).pathname.split("/").at(-1)!,
  );
  await mismatched.service.approve(mismatchLink, viewer, "github-token");
  await assert.rejects(mismatched.service.poll(mismatchStart.deviceCode), hasStatus(401));
  const mismatchToken = [...mismatched.store.access.values()][0];
  assert.equal(mismatchToken?.revokedAt, mismatched.now());
});

test("native access retains credentials when an unavailable email lookup makes denial ambiguous", async () => {
  let emailLookupComplete = true;
  let denyCurrentAuthorization = false;
  const subject = harness({
    async refreshGitHubUserEvidence() {
      return {
        user: { ...viewer, email: null },
        emailLookupComplete,
      };
    },
    async reauthorize(user) {
      if (denyCurrentAuthorization) {
        throw Object.assign(new Error("user is no longer allowlisted"), { status: 403 });
      }
      return user;
    },
  });
  const started = await subject.service.start("Peter's Mac", "192.0.2.1");
  const linkCode = decodeURIComponent(new URL(started.verificationUri).pathname.split("/").at(-1)!);
  await subject.service.approve(linkCode, viewer, "github-token");
  const exchanged = await subject.service.poll(started.deviceCode);
  assert.equal(exchanged.kind, "authorized");
  if (exchanged.kind !== "authorized") return;
  const request = new Request("https://fleet.example/api/native/v1/fleet", {
    headers: { authorization: `Bearer ${exchanged.accessToken}` },
  });
  const tokenHash = await sha256(exchanged.accessToken);

  emailLookupComplete = false;
  denyCurrentAuthorization = true;
  await assert.rejects(subject.service.authenticate(request), hasStatus(503));
  assert.equal(subject.store.access.get(tokenHash)?.revokedAt, null);
  assert.ok(subject.store.access.get(tokenHash)?.githubTokenCiphertext);

  emailLookupComplete = true;
  await assert.rejects(subject.service.authenticate(request), hasStatus(401));
  assert.equal(subject.store.access.get(tokenHash)?.revokedAt, subject.now());
  assert.equal(subject.store.access.get(tokenHash)?.githubTokenCiphertext, null);
});

test("native token revocation is local even when GitHub refresh is unavailable", async () => {
  let refreshAvailable = true;
  let refreshCalls = 0;
  const subject = harness({
    async refreshGitHubUser() {
      refreshCalls += 1;
      if (!refreshAvailable) throw new Error("GitHub unavailable");
      return viewer;
    },
  });
  const started = await subject.service.start("Peter's Mac", "192.0.2.1");
  const linkCode = decodeURIComponent(new URL(started.verificationUri).pathname.split("/").at(-1)!);
  await subject.service.approve(linkCode, viewer, "github-token");
  const exchanged = await subject.service.poll(started.deviceCode);
  assert.equal(exchanged.kind, "authorized");
  if (exchanged.kind !== "authorized") return;
  assert.equal(refreshCalls, 1);

  refreshAvailable = false;
  const request = new Request("https://fleet.example/api/native/v1/auth/token", {
    method: "DELETE",
    headers: { authorization: `Bearer ${exchanged.accessToken}` },
  });
  await subject.service.revoke(request);
  assert.equal(refreshCalls, 1);
  const tokenHash = await sha256(exchanged.accessToken);
  assert.equal(subject.store.access.get(tokenHash)?.revokedAt, subject.now());
  assert.equal(subject.store.access.get(tokenHash)?.githubTokenCiphertext, null);
  await assert.rejects(subject.service.revoke(request), hasStatus(401));
  assert.equal(refreshCalls, 1);
});

test("native auth pruning removes expired credentials without a new device start", async () => {
  const unconsumed = harness();
  const pending = await unconsumed.service.start("Pending Mac", "192.0.2.1");
  const pendingLink = decodeURIComponent(
    new URL(pending.verificationUri).pathname.split("/").at(-1)!,
  );
  await unconsumed.service.approve(pendingLink, viewer, "github-token");
  assert.ok([...unconsumed.store.access.values()][0]?.githubTokenCiphertext);

  unconsumed.setNow(pending.expiresAt);
  await unconsumed.service.pruneExpired();

  assert.equal(unconsumed.store.devices.size, 0);
  assert.equal(unconsumed.store.access.size, 0);

  const consumed = harness();
  const started = await consumed.service.start("Connected Mac", "192.0.2.2");
  const linkCode = decodeURIComponent(new URL(started.verificationUri).pathname.split("/").at(-1)!);
  await consumed.service.approve(linkCode, viewer, "github-token");
  const exchanged = await consumed.service.poll(started.deviceCode);
  assert.equal(exchanged.kind, "authorized");
  if (exchanged.kind !== "authorized") return;
  const tokenHash = await sha256(exchanged.accessToken);

  consumed.setNow(started.expiresAt);
  await consumed.service.pruneExpired();

  assert.equal(consumed.store.devices.size, 0);
  assert.ok(consumed.store.access.get(tokenHash)?.githubTokenCiphertext);

  consumed.setNow(exchanged.expiresAt);
  await consumed.service.pruneExpired();
  assert.equal(consumed.store.access.size, 0);
});

test("D1 native pruning deletes abandoned grants before expired devices", async () => {
  const statements: Array<{ sql: string; parameters: unknown[] }> = [];
  const database = {
    prepare(sql: string) {
      return {
        bind(...parameters: unknown[]) {
          return { sql, parameters };
        },
      };
    },
    async batch(values: Array<{ sql: string; parameters: unknown[] }>) {
      statements.push(...values);
      return [];
    },
  } as unknown as D1Database;

  await createNativeAuthService({ DB: database } as RuntimeEnv).pruneExpired(123_456);

  assert.equal(statements.length, 3);
  const sql = statements.map((statement) => statement.sql.replace(/\s+/gu, " ").toLowerCase());
  assert.match(
    sql[0] ?? "",
    /delete from native_access_tokens where token_hash in \( select access_token_hash from native_device_authorizations where expires_at <= \? and consumed_at is null and access_token_hash is not null \)/,
  );
  assert.match(sql[1] ?? "", /delete from "native_device_authorizations"/);
  assert.match(sql[2] ?? "", /delete from "native_access_tokens"/);
  assert.deepEqual(
    statements.map((statement) => statement.parameters),
    [[123_456], [123_456], [123_456]],
  );
});

function hasStatus(expected: number): (error: unknown) => boolean {
  return (error) => httpStatus(error) === expected;
}

function httpStatus(error: unknown): number | undefined {
  return typeof error === "object" && error && "status" in error ? Number(error.status) : undefined;
}
