import type { RuntimeEnv } from "./env.ts";
import { database } from "./database.ts";
import type { WorkflowConfig } from "./card-model.ts";
import type { RepoWorkflow } from "./workflow-model.ts";

export type WorkflowRepositoryStore = {
  read(repo: string): Promise<RepoWorkflow | null>;
  summaries(): Promise<RepoWorkflow[]>;
  write(workflow: RepoWorkflow): Promise<RepoWorkflow>;
};

export class WorkflowRepository implements WorkflowRepositoryStore {
  private readonly env: RuntimeEnv;

  constructor(env: RuntimeEnv) {
    this.env = env;
  }

  async read(repo: string): Promise<RepoWorkflow | null> {
    const row = await database(this.env)
      .selectFrom("repo_workflows")
      .selectAll()
      .where("repo", "=", repo)
      .executeTakeFirst();
    return row ? repoWorkflow(row) : null;
  }

  async summaries(): Promise<RepoWorkflow[]> {
    const rows = await database(this.env)
      .selectFrom("repo_workflows")
      .select([
        "repo",
        "status",
        "source_path",
        "source_sha",
        "config_json",
        "error",
        "evaluated_at",
        "updated_at",
      ])
      .orderBy("updated_at", "desc")
      .limit(80)
      .execute();
    return rows.map((row) => repoWorkflow({ ...row, prompt: "" }));
  }

  async write(workflow: RepoWorkflow): Promise<RepoWorkflow> {
    await database(this.env)
      .insertInto("repo_workflows")
      .values({
        repo: workflow.repo,
        status: workflow.status,
        source_path: workflow.sourcePath,
        source_sha: workflow.sourceSha,
        config_json: JSON.stringify(workflow.config),
        prompt: workflow.prompt,
        error: workflow.error,
        evaluated_at: workflow.evaluatedAt,
        updated_at: workflow.updatedAt,
      })
      .onConflict((conflict) =>
        conflict.column("repo").doUpdateSet({
          status: workflow.status,
          source_path: workflow.sourcePath,
          source_sha: workflow.sourceSha,
          config_json: JSON.stringify(workflow.config),
          prompt: workflow.prompt,
          error: workflow.error,
          evaluated_at: workflow.evaluatedAt,
          updated_at: workflow.updatedAt,
        }),
      )
      .execute();
    return workflow;
  }
}

function repoWorkflow(row: {
  repo: string;
  status: RepoWorkflow["status"];
  source_path: string;
  source_sha: string | null;
  config_json: string;
  prompt: string;
  error: string | null;
  evaluated_at: number;
  updated_at: number;
}): RepoWorkflow {
  return {
    repo: row.repo,
    status: row.status,
    sourcePath: row.source_path,
    sourceSha: row.source_sha,
    config: parseJson<WorkflowConfig>(row.config_json, {}),
    prompt: row.prompt,
    error: row.error,
    evaluatedAt: row.evaluated_at,
    updatedAt: row.updated_at,
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
