import type { Insertable } from "kysely";

import type { InteractiveSessionRow, InteractiveSessionTable } from "./database.ts";
import { database } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import type { GitHubActionsRunnerConnectionUpdate } from "./github-actions-runner-connection.ts";
import type { GitHubActionsSessionRegistrationUpdate } from "./github-actions-session-registration.ts";
import type { GitHubActionsWorkStateUpdate } from "./github-actions-session-work-state.ts";

type GitHubActionsSessionUpdate =
  | GitHubActionsSessionRegistrationUpdate
  | GitHubActionsWorkStateUpdate
  | GitHubActionsRunnerConnectionUpdate;

export class GitHubActionsRepository {
  private readonly env: RuntimeEnv;

  constructor(env: RuntimeEnv) {
    this.env = env;
  }

  async readByWorkKey(workKey: string): Promise<InteractiveSessionRow | null> {
    return (
      (await database(this.env)
        .selectFrom("interactive_sessions")
        .selectAll()
        .where("work_key", "=", workKey)
        .executeTakeFirst()) ?? null
    );
  }

  async readById(id: string): Promise<InteractiveSessionRow | null> {
    return (
      (await database(this.env)
        .selectFrom("interactive_sessions")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst()) ?? null
    );
  }

  async insertSession(values: Insertable<InteractiveSessionTable>): Promise<void> {
    await database(this.env).insertInto("interactive_sessions").values(values).execute();
  }

  async adoptLegacyOwner(id: string, owner: string, ownerSubject: string): Promise<boolean> {
    const result = await database(this.env)
      .updateTable("interactive_sessions")
      .set({ owner, owner_subject: ownerSubject })
      .where("id", "=", id)
      .where("owner_subject", "=", "")
      .executeTakeFirst();
    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  async updateSession(id: string, values: GitHubActionsSessionUpdate): Promise<void> {
    await database(this.env)
      .updateTable("interactive_sessions")
      .set(values)
      .where("id", "=", id)
      .execute();
  }
}
