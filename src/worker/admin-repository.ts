import { database } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import type { Role } from "./models.ts";

export type AllowEntry = { value: string; role: Role };

export class AdminRepository {
  private readonly env: RuntimeEnv;
  constructor(env: RuntimeEnv) {
    this.env = env;
  }

  readAllowEntries(): Promise<AllowEntry[]> {
    return database(this.env)
      .selectFrom("allow_entries")
      .select(["value", "role"])
      .orderBy("value")
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
}
