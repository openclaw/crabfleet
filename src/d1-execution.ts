import type { CompiledQuery, DatabaseConnection, QueryResult } from "kysely";

type D1ExecutionMeta = {
  changes?: number;
  last_row_id?: number;
};

type D1ExecutionResult<R> = {
  results?: R[];
  meta: D1ExecutionMeta;
};

export type D1StatementExecution = {
  all<R>(): Promise<D1ExecutionResult<R>>;
  run(): Promise<D1ExecutionResult<unknown>>;
};

export type D1Execution<R> = {
  rows: R[];
  changes?: number;
  lastRowId?: number;
};

export class D1Connection implements DatabaseConnection {
  private readonly d1: D1Database;

  constructor(d1: D1Database) {
    this.d1 = d1;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const statement = this.d1.prepare(compiledQuery.sql).bind(...compiledQuery.parameters);
    const result = await executeD1Statement<R>(statement, compiledQuery.sql);
    const queryResult: QueryResult<R> = { rows: result.rows };
    if (typeof result.changes === "number") {
      Object.assign(queryResult, { numAffectedRows: BigInt(result.changes) });
    }
    if (typeof result.lastRowId === "number") {
      Object.assign(queryResult, { insertId: BigInt(result.lastRowId) });
    }
    return queryResult;
  }

  async *streamQuery<R>(compiledQuery: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    yield await this.executeQuery<R>(compiledQuery);
  }
}

export async function executeD1Statement<R>(
  statement: D1StatementExecution,
  sqlText: string,
): Promise<D1Execution<R>> {
  const returnsRows = d1QueryReturnsRows(sqlText);
  const result = returnsRows ? await statement.all<R>() : await statement.run();
  return {
    rows: returnsRows ? ((result.results ?? []) as R[]) : [],
    ...(typeof result.meta.changes === "number" ? { changes: result.meta.changes } : {}),
    ...(typeof result.meta.last_row_id === "number" ? { lastRowId: result.meta.last_row_id } : {}),
  };
}

export function d1QueryReturnsRows(sqlText: string): boolean {
  const normalized = sqlText.trim();
  return /^(?:select|with|pragma)\b/i.test(normalized) || /\breturning\b/i.test(normalized);
}
