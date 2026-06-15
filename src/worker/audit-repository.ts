import { database } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";

export class AuditRepository {
  private readonly env: RuntimeEnv;

  constructor(env: RuntimeEnv) {
    this.env = env;
  }

  async record(actor: string, message: string, now: number): Promise<void> {
    await database(this.env)
      .insertInto("audit_events")
      .values({ actor, message, created_at: now })
      .execute();
  }
}
