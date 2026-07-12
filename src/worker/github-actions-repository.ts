import type { Insertable } from "kysely";

import type { InteractiveSessionRow, InteractiveSessionTable } from "./database.ts";
import { database } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import type { GitHubActionsRunnerConnectionUpdate } from "./github-actions-runner-connection.ts";
import type {
  GitHubActionsSessionRegistrationExpectation,
  GitHubActionsSessionRegistrationUpdate,
} from "./github-actions-session-registration.ts";
import type { GitHubActionsWorkStateUpdate } from "./github-actions-session-work-state.ts";
import { conflict } from "./http.ts";
import type { InteractiveSessionStatus } from "./models.ts";

type GitHubActionsSessionUpdate =
  | GitHubActionsSessionRegistrationUpdate
  | GitHubActionsWorkStateUpdate
  | GitHubActionsRunnerConnectionUpdate;

const terminalWorkStates = ["completed", "failed", "canceled", "blocked"];
const terminalSessionStatuses = ["stopped", "expired", "failed"] as const;

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

  async updateSession(
    id: string,
    values: GitHubActionsSessionUpdate,
    expectedRegistration?: GitHubActionsSessionRegistrationExpectation,
    expectedTerminalStatus?: InteractiveSessionStatus,
  ): Promise<void> {
    let update = database(this.env)
      .updateTable("interactive_sessions")
      .set(values)
      .where("id", "=", id)
      .where("runtime", "=", "github_actions");

    if (isRegistrationUpdate(values)) {
      if (!expectedRegistration) {
        throw new Error("GitHub Actions registration update requires expected state");
      }
      update = update
        .where("updated_at", "=", expectedRegistration.updated_at)
        .where("status", "=", expectedRegistration.status)
        .where("work_state", "=", expectedRegistration.work_state)
        .where("work_phase", "=", expectedRegistration.work_phase)
        .where("owner_subject", "=", values.owner_subject);
      update =
        expectedRegistration.agent_token_hash === null
          ? update.where("agent_token_hash", "is", null)
          : update.where("agent_token_hash", "=", expectedRegistration.agent_token_hash);
    } else if (isWorkStateUpdate(values) && terminalWorkStates.includes(values.work_state)) {
      if (!expectedTerminalStatus) {
        throw new Error("terminal GitHub Actions update requires expected session status");
      }
      update = update
        .where("updated_at", "<=", values.updated_at)
        .where("status", "=", expectedTerminalStatus)
        .where("status", "not in", terminalSessionStatuses)
        .where((expressions) =>
          expressions.or([
            expressions("work_state", "not in", terminalWorkStates),
            expressions("work_state", "=", values.work_state),
          ]),
        );
    } else {
      update = update
        .where("updated_at", "<=", values.updated_at)
        .where("work_state", "not in", terminalWorkStates)
        .where("status", "not in", terminalSessionStatuses);
    }

    const result = await update.executeTakeFirst();
    if ((result.numUpdatedRows ?? 0n) !== 1n) {
      throw conflict("GitHub Actions session changed; retry");
    }
  }
}

function isRegistrationUpdate(
  values: GitHubActionsSessionUpdate,
): values is GitHubActionsSessionRegistrationUpdate {
  return "agent_token_hash" in values;
}

function isWorkStateUpdate(
  values: GitHubActionsSessionUpdate,
): values is GitHubActionsWorkStateUpdate {
  return "stopped_at" in values && "codex_thread_id" in values;
}
