import { sql } from "kysely";

import { database } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import { forbidden } from "./http.ts";
import type { Role } from "./models.ts";

export type AdminPolicy = {
  cap: number;
  retention: string;
  merge: string;
};

export type AllowEntry = {
  value: string;
  role: Role;
};

export type AdminRepositoryStore = {
  readSettings(): Promise<Record<string, string>>;
  readAllowEntries(): Promise<AllowEntry[]>;
  readEnabledRepos(): Promise<string[]>;
  requireRepo(repo: string): Promise<void>;
  writePolicy(policy: AdminPolicy): Promise<void>;
  upsertAllowEntry(value: string, role: Role, now: number): Promise<void>;
  removeAllowEntry(value: string): Promise<void>;
  upsertRepo(repo: string, now: number): Promise<void>;
  disableRepo(repo: string, now: number): Promise<void>;
};

export type AdminMutationStore = Pick<
  AdminRepositoryStore,
  | "requireRepo"
  | "writePolicy"
  | "upsertAllowEntry"
  | "removeAllowEntry"
  | "upsertRepo"
  | "disableRepo"
>;

export class AdminRepository implements AdminRepositoryStore {
  private readonly env: RuntimeEnv;

  constructor(env: RuntimeEnv) {
    this.env = env;
  }

  async readSettings(): Promise<Record<string, string>> {
    const rows = await database(this.env).selectFrom("settings").select(["key", "value"]).execute();
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  readAllowEntries(): Promise<AllowEntry[]> {
    return database(this.env)
      .selectFrom("allow_entries")
      .select(["value", "role"])
      .orderBy("value")
      .execute();
  }

  async readEnabledRepos(): Promise<string[]> {
    const rows = await database(this.env)
      .selectFrom("repos")
      .select("repo")
      .where("enabled", "=", 1)
      .orderBy("repo")
      .execute();
    return rows.map((row) => row.repo);
  }

  async requireRepo(repo: string): Promise<void> {
    const row = await database(this.env)
      .selectFrom("repos")
      .select("repo")
      .where("repo", "=", repo)
      .where("enabled", "=", 1)
      .executeTakeFirst();
    if (!row) throw forbidden(`repo blocked by allowlist: ${repo}`);
  }

  async writePolicy(policy: AdminPolicy): Promise<void> {
    await database(this.env)
      .insertInto("settings")
      .values([
        { key: "cap", value: String(policy.cap) },
        { key: "retention", value: policy.retention },
        { key: "merge", value: policy.merge },
      ])
      .onConflict((conflict) =>
        conflict.column("key").doUpdateSet({ value: sql<string>`excluded.value` }),
      )
      .execute();
  }

  async upsertAllowEntry(value: string, role: Role, now: number): Promise<void> {
    await database(this.env)
      .insertInto("allow_entries")
      .values({ value, role, created_at: now, updated_at: now })
      .onConflict((conflict) => conflict.column("value").doUpdateSet({ role, updated_at: now }))
      .execute();
  }

  async removeAllowEntry(value: string): Promise<void> {
    await database(this.env).deleteFrom("allow_entries").where("value", "=", value).execute();
  }

  async upsertRepo(repo: string, now: number): Promise<void> {
    await database(this.env)
      .insertInto("repos")
      .values({ repo, enabled: 1, created_at: now, updated_at: now })
      .onConflict((conflict) =>
        conflict.column("repo").doUpdateSet({ enabled: 1, updated_at: now }),
      )
      .execute();
  }

  async disableRepo(repo: string, now: number): Promise<void> {
    await database(this.env)
      .updateTable("repos")
      .set({ enabled: 0, updated_at: now })
      .where("repo", "=", repo)
      .execute();
  }
}
