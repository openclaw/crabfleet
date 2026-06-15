export type CardSchedule = {
  kind: "interval";
  everyMs: number;
  startAt?: number | null;
};

const minIntervalMs = 60_000;
const maxIntervalMs = 31 * 24 * 60 * 60 * 1000;

export function normalizeCardSchedule(input: unknown): CardSchedule | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "object" || Array.isArray(input))
    throw new Error("schedule must be an object");
  const data = input as Record<string, unknown>;
  const kind = String(data.kind ?? "");
  if (kind !== "interval") throw new Error("schedule.kind must be interval");
  const everyMs = Number(data.everyMs ?? data.intervalMs);
  if (!Number.isFinite(everyMs) || !Number.isInteger(everyMs))
    throw new Error("schedule.everyMs must be an integer");
  if (everyMs < minIntervalMs || everyMs > maxIntervalMs)
    throw new Error("schedule.everyMs must be between 60000 and 2678400000");
  const startAtValue = data.startAt ?? data.start_at;
  const startAt =
    startAtValue === undefined || startAtValue === null || startAtValue === ""
      ? null
      : Number(startAtValue);
  if (startAt !== null && (!Number.isFinite(startAt) || !Number.isInteger(startAt) || startAt < 0))
    throw new Error("schedule.startAt must be a unix epoch millisecond integer");
  return { kind, everyMs, ...(startAt === null ? {} : { startAt }) };
}

export function parseStoredCardSchedule(value: unknown): CardSchedule | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return normalizeCardSchedule(JSON.parse(text));
}

export function nextRecurringRunAt(
  schedule: CardSchedule,
  now: number,
  lastScheduledRunAt: number | null,
): number {
  const first = schedule.startAt ?? null;
  if (lastScheduledRunAt === null && first !== null && first > now) return first;
  let next = (lastScheduledRunAt ?? first ?? now) + schedule.everyMs;
  while (next <= now) next += schedule.everyMs;
  return next;
}

export function cardScheduleSummary(schedule: CardSchedule): string {
  return `interval every ${schedule.everyMs}ms`;
}
