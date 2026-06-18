export type CardSchedule = {
  kind: "interval";
  everyMs: number;
  startAt?: number;
};

export const minimumCardScheduleIntervalMs = 60_000;
export const maximumCardScheduleIntervalMs = 31 * 24 * 60 * 60 * 1000;

export function normalizeCardSchedule(input: unknown): CardSchedule | null {
  if (input === undefined || input === null || input === "") return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("schedule must be an object");
  }
  const data = input as Record<string, unknown>;
  const unsupportedFields = Object.keys(data).filter(
    (key) => key !== "kind" && key !== "everyMs" && key !== "startAt",
  );
  if (unsupportedFields.length) {
    throw new Error(`schedule contains unsupported field: ${unsupportedFields[0]}`);
  }
  if (data.kind !== "interval") throw new Error("schedule.kind must be interval");
  if (!Number.isSafeInteger(data.everyMs)) {
    throw new Error("schedule.everyMs must be a safe integer");
  }
  const everyMs = data.everyMs as number;
  if (everyMs < minimumCardScheduleIntervalMs || everyMs > maximumCardScheduleIntervalMs) {
    throw new Error(
      `schedule.everyMs must be between ${minimumCardScheduleIntervalMs} and ${maximumCardScheduleIntervalMs}`,
    );
  }
  if (data.startAt === undefined || data.startAt === null || data.startAt === "") {
    return { kind: "interval", everyMs };
  }
  if (!Number.isSafeInteger(data.startAt) || Number(data.startAt) < 0) {
    throw new Error("schedule.startAt must be a non-negative unix epoch millisecond integer");
  }
  return { kind: "interval", everyMs, startAt: data.startAt as number };
}

export function parseStoredCardSchedule(value: string): CardSchedule | null {
  const text = value.trim();
  return text ? normalizeCardSchedule(JSON.parse(text)) : null;
}

export function initialRecurringRunAt(schedule: CardSchedule, now: number): number {
  if (schedule.startAt !== undefined && schedule.startAt > now) return schedule.startAt;
  return nextRecurringRunAt(schedule, schedule.startAt ?? now, now);
}

export function nextRecurringRunAt(
  schedule: CardSchedule,
  scheduledAt: number,
  now: number,
): number {
  const elapsed = Math.max(0, now - scheduledAt);
  const intervals = Math.floor(elapsed / schedule.everyMs) + 1;
  const next = scheduledAt + intervals * schedule.everyMs;
  if (!Number.isSafeInteger(next))
    throw new Error("next recurring run exceeds safe timestamp range");
  return next;
}

export function cardScheduleSummary(schedule: CardSchedule): string {
  return `interval every ${schedule.everyMs}ms`;
}
