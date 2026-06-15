import { badRequest } from "./http.ts";
import { deadInteractiveSessionStatuses } from "./models.ts";
import type { InteractiveSession } from "./session-model.ts";

export type OpenClawTerminalSocket = {
  send(data: Uint8Array): void;
  close(code: number, reason: string): void;
};

export type OpenClawMutationStore = {
  now(): number;
  recordEvent(sessionId: string, message: string, now: number): Promise<void>;
  audit(message: string, now: number): Promise<void>;
  openTerminal(session: InteractiveSession): Promise<OpenClawTerminalSocket>;
  stopSession(sessionId: string): Promise<InteractiveSession>;
  warn(event: Record<string, unknown>): void;
};

const encoder = new TextEncoder();

export class OpenClawMutationService {
  private readonly store: OpenClawMutationStore;

  constructor(store: OpenClawMutationStore) {
    this.store = store;
  }

  async sendMessage(
    session: InteractiveSession,
    input: { message?: unknown; enter?: unknown },
  ): Promise<void> {
    if (session.status === "stopping" || deadInteractiveSessionStatuses.includes(session.status)) {
      throw badRequest(`session is ${session.status}`);
    }
    if (!session.capabilities.terminal) {
      throw badRequest("session does not advertise terminal access");
    }
    const message = clean(input.message, 4000);
    if (!message) throw badRequest("message is required");

    const now = this.store.now();
    await this.store.recordEvent(session.id, "OpenClaw service nudge requested", now);
    await this.store.audit(`openclaw crabbox message requested ${session.id}`, now);
    const socket = await this.store.openTerminal(session);
    socket.send(encoder.encode(`${message}${input.enter === false ? "" : "\r"}`));
    try {
      socket.close(1000, "OpenClaw service nudge sent");
    } catch {
      this.store.warn({
        event: "openclaw_message_socket_close_failed",
        sessionId: session.id,
      });
    }

    const deliveredAt = this.store.now();
    const deliveryRecords = await Promise.allSettled([
      this.store.recordEvent(session.id, "OpenClaw service nudge sent", deliveredAt),
      this.store.audit(`openclaw crabbox message sent ${session.id}`, deliveredAt),
    ]);
    if (deliveryRecords.some((record) => record.status === "rejected")) {
      this.store.warn({
        event: "openclaw_message_delivery_record_failed",
        sessionId: session.id,
      });
    }
  }

  async stopSession(sessionId: string): Promise<InteractiveSession> {
    await this.store.audit(`openclaw crabbox stop requested ${sessionId}`, this.store.now());
    return this.store.stopSession(sessionId);
  }
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
