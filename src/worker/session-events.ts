import { database, executeBatch } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import { badRequest, conflict, payloadTooLarge } from "./http.ts";
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
  persist(
    event: PersistedStructuredInteractiveSessionEvent,
  ): Promise<{ row: InteractiveSessionEventRow; inserted: boolean }>;
  invalidateTerminalFinalization(sessionId: string): Promise<void>;
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
    const persisted = await this.store.persist(event);
    if (!sameStructuredEvent(persisted.row, event)) {
      throw conflict("event key already belongs to a different session event");
    }
    await this.store.invalidateTerminalFinalization(event.sessionId);
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
  return new InteractiveSessionEventLedgerService({
    async persist(event) {
      const inserted = await db
        .insertInto("interactive_session_events")
        .values({
          session_id: event.sessionId,
          actor: event.actor,
          event_key: event.eventKey,
          event_type: event.type,
          message: event.message,
          payload_json: event.payloadJson,
          created_at: event.now,
        })
        .onConflict((constraint) => constraint.doNothing())
        .returningAll()
        .executeTakeFirst();
      const row =
        inserted ??
        (await db
          .selectFrom("interactive_session_events")
          .selectAll()
          .where("session_id", "=", event.sessionId)
          .where("event_key", "=", event.eventKey)
          .executeTakeFirst());
      if (!row) throw new Error("structured session event was not persisted");
      return { row, inserted: Boolean(inserted) };
    },
    async invalidateTerminalFinalization(sessionId) {
      await executeBatch(env, [terminalFinalizationPendingQuery(db, sessionId)]);
    },
    archive,
  }).append(input);
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
  const payload = canonicalJsonValue(record, new Set(), 0, { members: 0 });
  const payloadJson = JSON.stringify(payload);
  if (encoder.encode(payloadJson).byteLength > structuredEventPayloadMaxBytes) {
    throw payloadTooLarge(
      `payload must be at most ${structuredEventPayloadMaxBytes} serialized bytes`,
    );
  }
  return payloadJson;
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
