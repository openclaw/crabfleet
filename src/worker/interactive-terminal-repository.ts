import { sql } from "kysely";

import { database } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import {
  interactiveSession,
  runtimeCapabilities,
  type InteractiveSession,
} from "./session-model.ts";

export type InteractiveTerminalShareCredential = {
  tokenHash: string | null;
  shareMode: string;
  status: string;
  terminalAvailable: boolean;
};

export type InteractiveTerminalConnectionState = {
  status: string;
  lastEvent: string;
  lastSeenAt: number;
};

export class InteractiveTerminalRepository {
  private readonly env: RuntimeEnv;

  constructor(env: RuntimeEnv) {
    this.env = env;
  }

  async readSession(sessionId: string): Promise<InteractiveSession | null> {
    const row = await database(this.env)
      .selectFrom("interactive_sessions")
      .selectAll()
      .where("id", "=", sessionId)
      .executeTakeFirst();
    return row ? interactiveSession(row, []) : null;
  }

  async readShareCredential(sessionId: string): Promise<InteractiveTerminalShareCredential | null> {
    const row = await database(this.env)
      .selectFrom("interactive_sessions")
      .select(["share_token_hash", "share_mode", "status", "runtime", "capabilities_json"])
      .where("id", "=", sessionId)
      .where("share_mode", "=", "link_read")
      .executeTakeFirst();
    return row
      ? {
          tokenHash: row.share_token_hash,
          shareMode: row.share_mode,
          status: row.status,
          terminalAvailable: runtimeCapabilities(row.runtime, row.capabilities_json).terminal,
        }
      : null;
  }

  async readMultiplayerMode(sessionId: string): Promise<boolean | null> {
    const row = await database(this.env)
      .selectFrom("interactive_sessions")
      .select("multiplayer_mode")
      .where("id", "=", sessionId)
      .executeTakeFirst();
    return row ? row.multiplayer_mode === 1 : null;
  }

  async readConnectionState(sessionId: string): Promise<InteractiveTerminalConnectionState | null> {
    const row = await database(this.env)
      .selectFrom("interactive_sessions")
      .select(["status", "last_event", "last_seen_at"])
      .where("id", "=", sessionId)
      .executeTakeFirst();
    return row
      ? {
          status: row.status,
          lastEvent: row.last_event,
          lastSeenAt: row.last_seen_at,
        }
      : null;
  }

  async markConnected(sessionId: string, message: string, now: number): Promise<void> {
    await database(this.env)
      .updateTable("interactive_sessions")
      .set({
        status: "attached",
        last_seen_at: now,
        last_event: message,
      })
      .where("id", "=", sessionId)
      .where("status", "in", ["ready", "attached", "detached"])
      .execute();
  }

  async markDetached(sessionId: string, message: string): Promise<boolean> {
    const update = await database(this.env)
      .updateTable("interactive_sessions")
      .set({
        status: "detached",
        last_event: message,
      })
      .where("id", "=", sessionId)
      .where("status", "in", ["ready", "attached", "detached"])
      .executeTakeFirst();
    return (update.numUpdatedRows ?? 0n) > 0n;
  }

  async markExpired(
    session: Pick<InteractiveSession, "id" | "status" | "updatedAt">,
    message: string,
    now: number,
  ): Promise<boolean> {
    const update = await database(this.env)
      .updateTable("interactive_sessions")
      .set({
        status: "expired",
        agent_token_hash: null,
        attach_url: null,
        vnc_url: null,
        controller: null,
        controller_subject: null,
        control_requested_by: null,
        control_requested_by_subject: null,
        control_requested_at: null,
        control_granted_at: null,
        control_expires_at: null,
        updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
        stopped_at: now,
        terminal_finalize_pending: 1,
        last_event: message,
      })
      .where("id", "=", session.id)
      .where("status", "=", session.status)
      .where("updated_at", "=", session.updatedAt)
      .executeTakeFirst();
    return (update.numUpdatedRows ?? 0n) > 0n;
  }
}
