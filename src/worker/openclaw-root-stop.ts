import { openClawRoomMaxSessions, openClawRoomRootAllowed } from "../openclaw-service.ts";
import type { InteractiveSessionRow } from "./database.ts";
import { notFound, serviceUnavailable } from "./http.ts";
import { deadInteractiveSessionStatuses } from "./models.ts";
import { interactiveSession, type InteractiveSession } from "./session-model.ts";

export type OpenClawRootStopStore = {
  readRootSession(rootSessionId: string): Promise<InteractiveSession | null>;
  recordStopRequested(rootSessionId: string, now: number): Promise<void>;
  closeAdmission(rootSessionId: string): Promise<void>;
  readRootRows(rootSessionId: string, maximumSessions: number): Promise<InteractiveSessionRow[]>;
  rollbackReservation(sessionId: string, createdAt: number): Promise<void>;
  stopSession(session: InteractiveSession): Promise<void>;
  reconcileSession(session: InteractiveSession, now: number): Promise<void>;
  readRootCompletion(rootSessionId: string): Promise<{ total: number; remaining: number }>;
  recordStopped(rootSessionId: string, now: number): Promise<void>;
};

export type OpenClawRootStopClock = {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
};

export type OpenClawRootStopResult = {
  rootSessionId: string;
  sessions: InteractiveSession[];
};

const defaultClock: OpenClawRootStopClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export class OpenClawRootStopService {
  private readonly store: OpenClawRootStopStore;
  private readonly adapterName: string;
  private readonly clock: OpenClawRootStopClock;
  private readonly maximumSessions: number;
  private readonly deadlineMilliseconds: number;

  constructor(
    store: OpenClawRootStopStore,
    adapterName: string,
    options: {
      clock?: OpenClawRootStopClock;
      maximumSessions?: number;
      deadlineMilliseconds?: number;
    } = {},
  ) {
    this.store = store;
    this.adapterName = adapterName;
    this.clock = options.clock ?? defaultClock;
    this.maximumSessions = options.maximumSessions ?? openClawRoomMaxSessions;
    this.deadlineMilliseconds = options.deadlineMilliseconds ?? 60_000;
  }

  async stop(rootSessionId: string): Promise<OpenClawRootStopResult> {
    const root = await this.store.readRootSession(rootSessionId);
    if (!root || !openClawRoomRootAllowed(root)) {
      throw notFound("session root not found");
    }
    await this.store.recordStopRequested(rootSessionId, this.clock.now());
    await this.store.closeAdmission(rootSessionId);

    const deadline = this.clock.now() + this.deadlineMilliseconds;
    let terminalReads = 0;
    let pollDelayMilliseconds = 250;
    let previousState = "";
    const lifecycleAttempts = new Map<string, number>();
    const nextLifecycleAttemptAt = new Map<string, number>();

    while (this.clock.now() < deadline) {
      let rows = await this.store.readRootRows(rootSessionId, this.maximumSessions);
      const pending = rows.filter((row) => row.preparation_pending !== 0).slice(0, 4);
      await Promise.all(
        pending.map((row) =>
          this.runBeforeDeadline(deadline, () =>
            this.store.rollbackReservation(row.id, row.created_at),
          ),
        ),
      );
      if (this.clock.now() >= deadline) break;

      rows = await this.store.readRootRows(rootSessionId, this.maximumSessions);
      const sessions = rows.map((row) => interactiveSession(row, []));
      const now = this.clock.now();
      const actionable = sessions
        .filter((session) => !deadInteractiveSessionStatuses.includes(session.status))
        .filter((session) => (nextLifecycleAttemptAt.get(session.id) ?? 0) <= now)
        .reverse()
        .slice(0, 4);
      await Promise.all(
        actionable.map(async (session) => {
          const attempt = (lifecycleAttempts.get(session.id) ?? 0) + 1;
          lifecycleAttempts.set(session.id, attempt);
          nextLifecycleAttemptAt.set(
            session.id,
            now + Math.min(10_000, 500 * 2 ** Math.min(attempt - 1, 5)),
          );
          if (session.status === "stopping" && session.adapter !== this.adapterName) {
            await this.runBeforeDeadline(deadline, () => this.store.reconcileSession(session, now));
            return;
          }
          await this.runBeforeDeadline(deadline, () => this.store.stopSession(session));
        }),
      );
      if (this.clock.now() >= deadline) break;

      rows = await this.store.readRootRows(rootSessionId, this.maximumSessions);
      const completion = await this.store.readRootCompletion(rootSessionId);
      terminalReads = completion.remaining === 0 ? terminalReads + 1 : 0;
      if (terminalReads >= 2) {
        await this.store.recordStopped(rootSessionId, this.clock.now());
        return {
          rootSessionId,
          sessions: rows.map((row) => interactiveSession(row, [])),
        };
      }
      const currentState = `${completion.total}:${completion.remaining}:${rows
        .map((row) => `${row.id}:${row.status}:${row.preparation_pending}`)
        .join("|")}`;
      pollDelayMilliseconds =
        currentState === previousState ? Math.min(2_000, pollDelayMilliseconds * 2) : 250;
      previousState = currentState;
      const remaining = deadline - this.clock.now();
      if (remaining <= 0) break;
      await this.clock.sleep(Math.min(pollDelayMilliseconds, remaining));
    }
    throw serviceUnavailable("OpenClaw session root cleanup did not reach a terminal state");
  }

  private async runBeforeDeadline(deadline: number, operation: () => Promise<void>): Promise<void> {
    const remaining = deadline - this.clock.now();
    if (remaining <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, remaining);
      void operation()
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(timer);
          resolve();
        });
    });
  }
}
