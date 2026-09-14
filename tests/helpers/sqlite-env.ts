import type { DatabaseSync } from "node:sqlite";
import type { RuntimeEnv } from "../../src/worker/env.ts";

type BoundStatement = {
  execute(): {
    results: Record<string, unknown>[];
    success: true;
    meta: { changes: number; last_row_id?: number };
  };
};

export function sqliteRuntimeEnv(sqlite: DatabaseSync): RuntimeEnv {
  function execute(sql: string, parameters: unknown[]) {
    const statement = sqlite.prepare(sql);
    if (/^\s*(?:select|pragma|with)\b|\breturning\b/i.test(sql)) {
      const results = statement.all(...parameters).map((row) => ({ ...row }));
      const changes = Number(sqlite.prepare("SELECT changes() AS changes").get()?.changes ?? 0);
      return { results, success: true as const, meta: { changes } };
    }
    const result = statement.run(...parameters);
    return {
      results: [],
      success: true as const,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            const bound = {
              execute: () => execute(sql, parameters),
              async all() {
                return bound.execute();
              },
              async run() {
                return bound.execute();
              },
            };
            return bound;
          },
        };
      },
      async batch(statements: D1PreparedStatement[]) {
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          const results = statements.map((statement) =>
            (statement as unknown as BoundStatement).execute(),
          );
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    } as unknown as D1Database,
  } as RuntimeEnv;
}
