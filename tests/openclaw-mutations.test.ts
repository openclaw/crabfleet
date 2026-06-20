import assert from "node:assert/strict";
import test from "node:test";

import {
  OpenClawMutationService,
  type OpenClawMutationStore,
  type OpenClawTerminalSocket,
} from "../src/worker/openclaw-mutations.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

function mutationStore(overrides: Partial<OpenClawMutationStore> = {}): OpenClawMutationStore {
  return {
    now: () => 1,
    recordEvent: async () => undefined,
    audit: async () => undefined,
    openTerminal: async () => ({ send() {}, close() {} }),
    stopSession: async (session) => ({ ...session, status: "stopped" }),
    warn: () => undefined,
    ...overrides,
  };
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : undefined;
}

test("OpenClaw nudges persist request evidence before terminal delivery", async () => {
  const calls: string[] = [];
  const times = [10, 20];
  let sent = "";
  const socket: OpenClawTerminalSocket = {
    send(data) {
      calls.push("send");
      sent = new TextDecoder().decode(data);
    },
    close() {
      calls.push("close");
    },
  };
  const service = new OpenClawMutationService(
    mutationStore({
      now: () => times.shift() ?? 20,
      recordEvent: async (_id, message, now) => {
        calls.push(`event:${message}:${now}`);
      },
      audit: async (message, now) => {
        calls.push(`audit:${message}:${now}`);
      },
      openTerminal: async () => {
        calls.push("open");
        return socket;
      },
    }),
  );
  const session = interactiveSession(sessionRow({ id: "IS-2" }), []);

  await service.sendMessage(session, { message: "  continue  " });
  assert.equal(sent, "continue\r");
  assert.deepEqual(calls, [
    "event:OpenClaw service nudge requested:10",
    "audit:openclaw crabbox message requested IS-2:10",
    "open",
    "send",
    "close",
    "event:OpenClaw service nudge sent:20",
    "audit:openclaw crabbox message sent IS-2:20",
  ]);
});

test("OpenClaw nudges reject unavailable terminals before recording evidence", async () => {
  let recorded = false;
  const service = new OpenClawMutationService(
    mutationStore({
      recordEvent: async () => {
        recorded = true;
      },
    }),
  );

  await assert.rejects(
    service.sendMessage(interactiveSession(sessionRow({ status: "stopping" }), []), {
      message: "continue",
    }),
    (error) => {
      assert.equal(status(error), 400);
      return true;
    },
  );
  await assert.rejects(
    service.sendMessage(
      interactiveSession(sessionRow({ capabilities_json: '{"terminal":false}' }), []),
      { message: "continue" },
    ),
    (error) => {
      assert.equal(status(error), 400);
      return true;
    },
  );
  assert.equal(recorded, false);
});

test("OpenClaw nudge close and delivery-record failures are best effort", async () => {
  const warnings: string[] = [];
  let eventCalls = 0;
  const service = new OpenClawMutationService(
    mutationStore({
      recordEvent: async () => {
        eventCalls += 1;
        if (eventCalls === 2) throw new Error("D1 unavailable");
      },
      openTerminal: async () => ({
        send() {},
        close() {
          throw new Error("already closed");
        },
      }),
      warn: (event) => {
        warnings.push(String(event.event));
      },
    }),
  );

  await service.sendMessage(interactiveSession(sessionRow(), []), {
    message: "continue",
    enter: false,
  });
  assert.deepEqual(warnings, [
    "openclaw_message_socket_close_failed",
    "openclaw_message_delivery_record_failed",
  ]);
});

test("OpenClaw stop records audit evidence before lifecycle mutation", async () => {
  const calls: string[] = [];
  const service = new OpenClawMutationService(
    mutationStore({
      audit: async () => {
        calls.push("audit");
      },
      stopSession: async (session) => {
        calls.push("stop");
        return { ...session, status: "stopped" };
      },
    }),
  );

  assert.equal(
    (await service.stopSession(interactiveSession(sessionRow({ id: "IS-2" }), []))).status,
    "stopped",
  );
  assert.deepEqual(calls, ["audit", "stop"]);
});
