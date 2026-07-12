import { sql } from "kysely";

import { database, executeBatch } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import { badRequest, conflict, forbidden, payloadTooLarge } from "./http.ts";
import { deadInteractiveSessionStatuses } from "./models.ts";
import { archiveInteractiveSessionLogs } from "./session-log-archive.ts";
import {
  interactiveSessionEvent,
  type InteractiveSessionEvent,
  type InteractiveSessionEventPayload,
  type InteractiveSessionEventPayloadValue,
  type InteractiveSessionEventRow,
} from "./session-model.ts";
import { terminalFinalizationPendingQuery } from "./session-terminal-finalization.ts";

const encoder = new TextEncoder();

export const structuredEventPayloadMaxBytes = 64 * 1024;
export const structuredEventPayloadMaxDepth = 16;
export const structuredEventPayloadMaxMembers = 1024;
export const structuredEventPayloadMaxStringBytes = 16 * 1024;
export const structuredEventLedgerMaxCount = 2048;
export const structuredEventLedgerMaxBytes = 8 * 1024 * 1024;

const structuredEventLedgerBudgetError = "structured session event budget exceeded";

export type AppendInteractiveSessionEventInput = {
  sessionId: string;
  actor: string;
  message: string;
  now: number;
};

export type InteractiveSessionEventArchive = (sessionId: string, now: number) => Promise<void>;

export type AppendStructuredInteractiveSessionEventInput = {
  sessionId: string;
  actor: string;
  eventKey: unknown;
  type: unknown;
  message: unknown;
  payload: unknown;
  now: number;
};

type PersistedStructuredInteractiveSessionEvent = {
  sessionId: string;
  actor: string;
  eventKey: string;
  type: string;
  message: string;
  payloadJson: string;
  now: number;
};

export type InteractiveSessionEventLedgerStore = {
  persistAndInvalidate(
    event: PersistedStructuredInteractiveSessionEvent,
  ): Promise<{ row: InteractiveSessionEventRow; inserted: boolean }>;
  archive(sessionId: string, now: number): Promise<void>;
};

export type AppendStructuredInteractiveSessionEventResult = {
  event: InteractiveSessionEvent;
  duplicate: boolean;
};

export class InteractiveSessionEventLedgerService {
  private readonly store: InteractiveSessionEventLedgerStore;

  constructor(store: InteractiveSessionEventLedgerStore) {
    this.store = store;
  }

  async append(
    input: AppendStructuredInteractiveSessionEventInput,
  ): Promise<AppendStructuredInteractiveSessionEventResult> {
    const event = normalizeStructuredEvent(input);
    const persisted = await this.store.persistAndInvalidate(event);
    if (!sameStructuredEvent(persisted.row, event)) {
      throw conflict("event key already belongs to a different session event");
    }
    await this.store.archive(event.sessionId, event.now).catch(() => undefined);
    return {
      event: interactiveSessionEvent(persisted.row),
      duplicate: !persisted.inserted,
    };
  }
}

export async function appendInteractiveSessionEventRecord(
  env: RuntimeEnv,
  input: AppendInteractiveSessionEventInput,
  archive: InteractiveSessionEventArchive = (sessionId, now) =>
    archiveInteractiveSessionLogs(env, sessionId, now),
): Promise<void> {
  const db = database(env);
  await executeBatch(env, [
    db.insertInto("interactive_session_events").values({
      session_id: input.sessionId,
      actor: input.actor,
      message: clean(input.message, 1000),
      created_at: input.now,
    }),
    terminalFinalizationPendingQuery(db, input.sessionId),
  ]);
  await archive(input.sessionId, input.now).catch(() => undefined);
}

export async function appendStructuredInteractiveSessionEventRecord(
  env: RuntimeEnv,
  input: AppendStructuredInteractiveSessionEventInput,
  archive: InteractiveSessionEventArchive = (sessionId, now) =>
    archiveInteractiveSessionLogs(env, sessionId, now),
): Promise<AppendStructuredInteractiveSessionEventResult> {
  const db = database(env);
  try {
    return await new InteractiveSessionEventLedgerService({
      async persistAndInvalidate(event) {
        // Terminal ledgers are immutable. The exact row check keeps retries
        // idempotent without letting a retained agent token add new history.
        const insert = sql<InteractiveSessionEventRow>`
          INSERT INTO interactive_session_events (
            session_id,
            actor,
            event_key,
            event_type,
            message,
            payload_json,
            created_at
          )
          SELECT
            ${event.sessionId},
            ${event.actor},
            ${event.eventKey},
            ${event.type},
            ${event.message},
            ${event.payloadJson},
            ${event.now}
          WHERE EXISTS (
            SELECT 1
            FROM interactive_sessions
            WHERE id = ${event.sessionId}
              AND status NOT IN ('stopping', 'stopped', 'expired', 'failed')
          )
          OR EXISTS (
            SELECT 1
            FROM interactive_session_events
            WHERE session_id = ${event.sessionId}
              AND event_key = ${event.eventKey}
              AND event_type = ${event.type}
              AND message = ${event.message}
              AND payload_json = ${event.payloadJson}
          )
          ON CONFLICT DO NOTHING
          RETURNING *
        `;
        const invalidate = db
          .updateTable("interactive_sessions")
          .set({ terminal_finalize_pending: 1 })
          .where("id", "=", event.sessionId)
          .where("status", "in", deadInteractiveSessionStatuses)
          .where(
            sql<boolean>`EXISTS (
              SELECT 1
              FROM interactive_session_events
              WHERE session_id = ${event.sessionId}
                AND event_key = ${event.eventKey}
                AND event_type = ${event.type}
                AND message = ${event.message}
                AND payload_json = ${event.payloadJson}
            )`,
          );
        const compiledInsert = insert.compile(db);
        const compiledInvalidate = invalidate.compile();
        const results = await env.DB.batch<InteractiveSessionEventRow>([
          env.DB.prepare(compiledInsert.sql).bind(...compiledInsert.parameters),
          env.DB.prepare(compiledInvalidate.sql).bind(...compiledInvalidate.parameters),
        ]);
        const inserted = results[0]?.results?.[0];
        const row =
          inserted ??
          (await db
            .selectFrom("interactive_session_events")
            .selectAll()
            .where("session_id", "=", event.sessionId)
            .where("event_key", "=", event.eventKey)
            .executeTakeFirst());
        if (!row) {
          const session = await db
            .selectFrom("interactive_sessions")
            .select("status")
            .where("id", "=", event.sessionId)
            .executeTakeFirst();
          if (
            session &&
            (session.status === "stopping" ||
              deadInteractiveSessionStatuses.includes(session.status))
          ) {
            throw forbidden("terminal sessions accept only exact event replays");
          }
          throw new Error("structured session event was not persisted");
        }
        return { row, inserted: Boolean(inserted) };
      },
      archive,
    }).append(input);
  } catch (error) {
    if (String(error).toLowerCase().includes(structuredEventLedgerBudgetError)) {
      throw payloadTooLarge(
        `structured events must stay within ${structuredEventLedgerMaxCount} events and ${structuredEventLedgerMaxBytes} UTF-8 bytes per session`,
      );
    }
    throw error;
  }
}

function normalizeStructuredEvent(
  input: AppendStructuredInteractiveSessionEventInput,
): PersistedStructuredInteractiveSessionEvent {
  const eventKey = requiredString(input.eventKey, "eventKey", 240);
  const type = requiredString(input.type, "type", 120);
  const message = requiredString(input.message, "message", 1000);
  const payloadJson = structuredPayloadJson(input.payload);
  return {
    sessionId: input.sessionId,
    actor: input.actor,
    eventKey,
    type,
    message,
    payloadJson,
    now: input.now,
  };
}

function sameStructuredEvent(
  row: InteractiveSessionEventRow,
  event: PersistedStructuredInteractiveSessionEvent,
): boolean {
  return (
    row.session_id === event.sessionId &&
    row.event_key === event.eventKey &&
    row.event_type === event.type &&
    row.message === event.message &&
    row.payload_json === event.payloadJson
  );
}

function structuredPayloadJson(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("payload must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const version = record.version;
  if (
    !Object.hasOwn(record, "version") ||
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    throw badRequest("payload.version must be a positive integer");
  }
  const payload = redactStructuredPayload(
    canonicalJsonValue(record, new Set(), 0, { members: 0 }) as InteractiveSessionEventPayload,
  );
  const payloadJson = JSON.stringify(payload);
  if (encoder.encode(payloadJson).byteLength > structuredEventPayloadMaxBytes) {
    throw payloadTooLarge(
      `payload must be at most ${structuredEventPayloadMaxBytes} serialized bytes`,
    );
  }
  return payloadJson;
}

const sensitivePayloadField =
  /^(?:api_?key|apikey|auth|authorization|client_?secret|cookie|credential|credentials|id_?token|password|passwd|private_?key|proxy_?authorization|refresh_?token|secret|session_?token|set_?cookie|sig|signature|signed_?url|ticket|token|x_?api_?key|.+(?:_api_?key|_credential|_credentials|_password|_private_?key|_secret|_signature|_ticket|_token))$/i;

function redactStructuredPayload(
  value: InteractiveSessionEventPayload,
): InteractiveSessionEventPayload {
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      sensitivePayloadField.test(normalizedPayloadField(key))
        ? "[redacted]"
        : redactStructuredPayloadValue(nested),
    ]),
  );
}

function redactStructuredPayloadValue(
  value: InteractiveSessionEventPayloadValue,
): InteractiveSessionEventPayloadValue {
  if (Array.isArray(value)) return value.map(redactStructuredPayloadValue);
  if (typeof value === "string") return redactedStructuredEventText(value);
  if (!value || typeof value !== "object") return value;
  return redactStructuredPayload(value);
}

function redactedStructuredEventText(value: string): string {
  const sensitiveName =
    "access[_-]?token|api[_-]?key|apikey|auth|authorization|client[_-]?secret|cookie|credential|id[_-]?token|password|passwd|private[_-]?key|proxy[_-]?authorization|refresh[_-]?token|secret|session[_-]?token|set[_-]?cookie|sig|signature|ticket|token|x[_-]?api[_-]?key";
  return value
    .replace(
      /\b(?:authorization|proxy-authorization|x-api-key|api-key)\s*:\s*[^\r\n]+/giu,
      "[credential]",
    )
    .replace(/\b(?:bearer|basic)\s+[^\s,;}\x5d]+/giu, "[credential]")
    .replace(/\b(?:cookie|set-cookie)\s*:\s*[^\r\n]+/giu, "[credential]")
    .replace(
      new RegExp(
        `(?:\\\\?["']?)(?:${sensitiveName})(?:\\\\?["']?)\\s*[:=]\\s*(?!\\[credential\\])(?:\\\\?["'](?:\\\\.|[^"'\\\\])*\\\\?["']|[^\\s,;}&}\\x5d]+)`,
        "giu",
      ),
      "[credential]",
    );
}

function normalizedPayloadField(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function canonicalJsonValue(
  value: unknown,
  parents: Set<object>,
  depth: number,
  budget: { members: number },
): InteractiveSessionEventPayloadValue {
  if (depth > structuredEventPayloadMaxDepth) {
    throw badRequest(`payload depth must be at most ${structuredEventPayloadMaxDepth}`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    assertPayloadStringSize(value);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw badRequest("payload must contain valid JSON values");
    return value;
  }
  if (typeof value !== "object") {
    throw badRequest("payload must contain valid JSON values");
  }
  if (parents.has(value)) throw badRequest("payload must contain valid JSON values");
  parents.add(value);
  try {
    if (Array.isArray(value)) {
      consumePayloadMembers(budget, value.length);
      return value.map((item) => canonicalJsonValue(item, parents, depth + 1, budget));
    }
    const keys = Object.keys(value).sort();
    consumePayloadMembers(budget, keys.length);
    for (const key of keys) assertPayloadStringSize(key);
    return Object.fromEntries(
      keys.map((key) => [
        key,
        canonicalJsonValue((value as Record<string, unknown>)[key], parents, depth + 1, budget),
      ]),
    ) as InteractiveSessionEventPayload;
  } finally {
    parents.delete(value);
  }
}

function consumePayloadMembers(budget: { members: number }, count: number): void {
  budget.members += count;
  if (budget.members > structuredEventPayloadMaxMembers) {
    throw badRequest(`payload must contain at most ${structuredEventPayloadMaxMembers} members`);
  }
}

function assertPayloadStringSize(value: string): void {
  if (encoder.encode(value).byteLength > structuredEventPayloadMaxStringBytes) {
    throw badRequest(
      `payload strings must be at most ${structuredEventPayloadMaxStringBytes} UTF-8 bytes`,
    );
  }
}

function requiredString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string") throw badRequest(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw badRequest(`${name} is required`);
  if (normalized.length > maximum) {
    throw badRequest(`${name} must be at most ${maximum} characters`);
  }
  return normalized;
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
