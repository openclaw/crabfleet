import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEnv } from "../src/worker/env.ts";
import {
  appendInteractiveSessionEventRecord,
  appendStructuredInteractiveSessionEventRecord,
  InteractiveSessionEventLedgerService,
  structuredEventLedgerMaxBytes,
  structuredEventLedgerMaxCount,
  structuredEventPayloadMaxBytes,
  structuredEventPayloadMaxDepth,
  structuredEventPayloadMaxMembers,
  structuredEventPayloadMaxStringBytes,
  type InteractiveSessionEventLedgerStore,
} from "../src/worker/session-events.ts";
import type { InteractiveSessionEventRow } from "../src/worker/session-model.ts";

type PreparedStatement = {
  sql: string;
  parameters: unknown[];
};

function runtimeEnv(onBatch: (statements: PreparedStatement[]) => void): RuntimeEnv {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            return { sql, parameters };
          },
        };
      },
      async batch(statements: unknown[]) {
        onBatch(statements as PreparedStatement[]);
        return [];
      },
    } as unknown as D1Database,
  } as RuntimeEnv;
}

test("session events persist before archive refresh and invalidate terminal finalization", async () => {
  const order: string[] = [];
  let statements: PreparedStatement[] = [];
  const env = runtimeEnv((batch) => {
    order.push("persist");
    statements = batch;
  });

  await appendInteractiveSessionEventRecord(
    env,
    {
      sessionId: "IS-1",
      actor: "operator",
      message: `  ${"x".repeat(1100)}  `,
      now: 123,
    },
    async (sessionId, now) => {
      order.push("archive");
      assert.equal(sessionId, "IS-1");
      assert.equal(now, 123);
    },
  );

  assert.deepEqual(order, ["persist", "archive"]);
  assert.equal(statements.length, 2);
  assert.match(statements[0]?.sql ?? "", /insert into "interactive_session_events"/i);
  assert.deepEqual(statements[0]?.parameters, ["IS-1", "operator", "x".repeat(1000), 123]);
  assert.match(statements[1]?.sql ?? "", /update "interactive_sessions"/i);
  assert.match(statements[1]?.sql ?? "", /"terminal_finalize_pending" = \?/i);
  assert.deepEqual(statements[1]?.parameters, [1, "IS-1", "stopped", "expired", "failed"]);
});

test("session event archive refresh remains best effort after durable persistence", async () => {
  let persisted = false;
  const env = runtimeEnv(() => {
    persisted = true;
  });

  await appendInteractiveSessionEventRecord(
    env,
    {
      sessionId: "IS-1",
      actor: "system",
      message: "completed",
      now: 123,
    },
    async () => {
      throw new Error("archive unavailable");
    },
  );

  assert.equal(persisted, true);
});

test("structured session events canonicalize additive payloads and replay idempotently", async () => {
  let row: InteractiveSessionEventRow | undefined;
  const persistedPayloads: string[] = [];
  const invalidations: string[] = [];
  const archives: string[] = [];
  const store: InteractiveSessionEventLedgerStore = {
    async persist(event) {
      persistedPayloads.push(event.payloadJson);
      invalidations.push(event.sessionId);
      if (!row) {
        row = {
          id: 1,
          session_id: event.sessionId,
          actor: event.actor,
          event_key: event.eventKey,
          event_type: event.type,
          message: event.message,
          payload_json: event.payloadJson,
          created_at: event.now,
        };
        return { row, inserted: true, refreshArchive: true };
      }
      return { row, inserted: false, refreshArchive: true };
    },
    async archive(sessionId) {
      archives.push(sessionId);
    },
  };
  const service = new InteractiveSessionEventLedgerService(store);
  const githubCredentialOne = `ghp_${"x".repeat(24)}`;
  const githubCredentialTwo = `ghp_${"y".repeat(24)}`;
  const providerCredentialOne = `sk-${"x".repeat(24)}`;
  const providerCredentialTwo = `sk-${"y".repeat(24)}`;
  const cloudCredentialOne = `AKIA${"X".repeat(16)}`;
  const cloudCredentialTwo = `ASIA${"Y".repeat(16)}`;
  const gitLabCredentialOne = `glpat-${"x".repeat(24)}`;
  const gitLabCredentialTwo = `glpat-${"y".repeat(24)}`;
  const privateKeyOne = [
    "-----BEGIN PRIVATE",
    "KEY-----\nZmFrZS1rZXktb25l\n-----END PRIVATE",
    "KEY-----",
  ].join(" ");
  const privateKeyTwo = [
    "-----BEGIN PRIVATE",
    "KEY-----\nZmFrZS1rZXktdHdv\n-----END PRIVATE",
    "KEY-----",
  ].join(" ");
  const first = await service.append({
    sessionId: "IS-1",
    actor: "operator",
    eventKey: " run:1 ",
    type: " clawsweeper.action ",
    message: ` updated pull request: authorization: Bearer credential-one\ncredentials=dummy\nSharedAccessKey=dummy\nhttps://alice:s3cr3t@example.com/repo\n${githubCredentialOne} `,
    payload: {
      version: 2,
      target: { z: true, a: 1 },
      additiveField: ["kept"],
      secretKey: "dummy",
      secretAccessKey: "dummy",
      accessKeyId: "dummy",
      accountKey: "dummy",
      connectionString: "dummy",
      sharedAccessKey: "dummy",
      credentials: {
        authorization: "Bearer credential-one",
        githubToken: "dummy",
      },
      note: "request failed: authorization: Bearer credential-one",
      remote: "https://alice:s3cr3t@example.com/repo",
      pemAssignment: `private_key=${privateKeyOne}`,
      storageKey: "dummy",
      tokenSamples: [
        githubCredentialOne,
        gitLabCredentialOne,
        providerCredentialOne,
        cloudCredentialOne,
        privateKeyOne,
      ],
      urlSamples: [
        "https://:secret@example.com/repo",
        "https://token:@example.com/repo",
        "https://alice:p@ss@example.com/repo",
        "https://alice@example.com:pass@host.example/repo",
      ],
    },
    now: 123,
  });
  const replay = await service.append({
    sessionId: "IS-1",
    actor: "operator",
    eventKey: "run:1",
    type: "clawsweeper.action",
    message: `updated pull request: authorization: Bearer credential-two\ncredentials=fake\nSharedAccessKey=fake\nhttps://bob:p%40ssword@example.com/repo\n${githubCredentialTwo}`,
    payload: {
      additiveField: ["kept"],
      secretKey: "fake",
      secretAccessKey: "fake",
      accessKeyId: "fake",
      accountKey: "fake",
      connectionString: "fake",
      sharedAccessKey: "fake",
      credentials: {
        authorization: "Bearer credential-two",
        githubToken: "fake",
      },
      note: "request failed: authorization: Bearer credential-two",
      remote: "https://bob:p%40ssword@example.com/repo",
      pemAssignment: `private_key=${privateKeyTwo}`,
      storageKey: "fake",
      tokenSamples: [
        githubCredentialTwo,
        gitLabCredentialTwo,
        providerCredentialTwo,
        cloudCredentialTwo,
        privateKeyTwo,
      ],
      urlSamples: [
        "https://:changed@example.com/repo",
        "https://changed:@example.com/repo",
        "https://bob:n@ew@example.com/repo",
        "https://bob@example.com:changed@host.example/repo",
      ],
      target: { a: 1, z: true },
      version: 2,
    },
    now: 456,
  });

  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.event, {
    actor: "operator",
    eventKey: "run:1",
    type: "clawsweeper.action",
    message:
      "updated pull request: [credential]\n[credential]\n[credential]\nhttps://[credential]@example.com/repo\n[credential]",
    payload: {
      accessKeyId: "[redacted]",
      accountKey: "[redacted]",
      additiveField: ["kept"],
      credentials: "[redacted]",
      connectionString: "[redacted]",
      note: "request failed: [credential]",
      pemAssignment: "private_key=[credential]",
      remote: "https://[credential]@example.com/repo",
      secretAccessKey: "[redacted]",
      secretKey: "[redacted]",
      sharedAccessKey: "[redacted]",
      storageKey: "[redacted]",
      target: { a: 1, z: true },
      tokenSamples: [
        "[credential]",
        "[credential]",
        "[credential]",
        "[credential]",
        "[credential]",
      ],
      urlSamples: [
        "https://[credential]@example.com/repo",
        "https://[credential]@example.com/repo",
        "https://[credential]@example.com/repo",
        "https://[credential]@host.example/repo",
      ],
      version: 2,
    },
    createdAt: 123,
  });
  assert.deepEqual(persistedPayloads, [
    '{"accessKeyId":"[redacted]","accountKey":"[redacted]","additiveField":["kept"],"connectionString":"[redacted]","credentials":"[redacted]","note":"request failed: [credential]","pemAssignment":"private_key=[credential]","remote":"https://[credential]@example.com/repo","secretAccessKey":"[redacted]","secretKey":"[redacted]","sharedAccessKey":"[redacted]","storageKey":"[redacted]","target":{"a":1,"z":true},"tokenSamples":["[credential]","[credential]","[credential]","[credential]","[credential]"],"urlSamples":["https://[credential]@example.com/repo","https://[credential]@example.com/repo","https://[credential]@example.com/repo","https://[credential]@host.example/repo"],"version":2}',
    '{"accessKeyId":"[redacted]","accountKey":"[redacted]","additiveField":["kept"],"connectionString":"[redacted]","credentials":"[redacted]","note":"request failed: [credential]","pemAssignment":"private_key=[credential]","remote":"https://[credential]@example.com/repo","secretAccessKey":"[redacted]","secretKey":"[redacted]","sharedAccessKey":"[redacted]","storageKey":"[redacted]","target":{"a":1,"z":true},"tokenSamples":["[credential]","[credential]","[credential]","[credential]","[credential]"],"urlSamples":["https://[credential]@example.com/repo","https://[credential]@example.com/repo","https://[credential]@example.com/repo","https://[credential]@host.example/repo"],"version":2}',
  ]);
  assert.deepEqual(invalidations, ["IS-1", "IS-1"]);
  assert.deepEqual(archives, ["IS-1", "IS-1"]);
});

test("structured event redaction spans private-key arrays and underscore secret tokens", async () => {
  let persistedMessage = "";
  let persistedPayload = "";
  const service = new InteractiveSessionEventLedgerService({
    async persist(event) {
      persistedMessage = event.message;
      persistedPayload = event.payloadJson;
      return {
        row: {
          id: 1,
          session_id: event.sessionId,
          actor: event.actor,
          event_key: event.eventKey,
          event_type: event.type,
          message: event.message,
          payload_json: event.payloadJson,
          created_at: event.now,
        },
        inserted: true,
        refreshArchive: false,
      };
    },
    async archive() {},
  });
  const secret = `sk_live_${"x".repeat(24)}`;

  const result = await service.append({
    sessionId: "IS-1",
    actor: "operator",
    eventKey: "run:private-key",
    type: "clawsweeper.action",
    message: secret,
    payload: {
      version: 1,
      output: [
        "-----BEGIN PRIVATE KEY-----",
        "ZmFrZS1rZXktbWF0ZXJpYWw=",
        "-----END PRIVATE KEY-----",
      ],
      commandOutput: `failed with ${secret}`,
    },
    now: 123,
  });

  assert.equal(persistedMessage, "[credential]");
  assert.deepEqual(JSON.parse(persistedPayload), {
    commandOutput: "failed with [credential]",
    output: ["[credential]", "[credential]", "[credential]"],
    version: 1,
  });
  assert.deepEqual(result.event.payload, {
    commandOutput: "failed with [credential]",
    output: ["[credential]", "[credential]", "[credential]"],
    version: 1,
  });
});

test("structured session event key conflicts reject changed content before side effects", async () => {
  const existing: InteractiveSessionEventRow = {
    id: 1,
    session_id: "IS-1",
    actor: "operator",
    event_key: "run:1",
    event_type: "clawsweeper.action",
    message: "original",
    payload_json: '{"version":1}',
    created_at: 123,
  };
  let archived = false;
  const service = new InteractiveSessionEventLedgerService({
    async persist() {
      return { row: existing, inserted: false, refreshArchive: true };
    },
    async archive() {
      archived = true;
    },
  });

  await assert.rejects(
    service.append({
      sessionId: "IS-1",
      actor: "operator",
      eventKey: "run:1",
      type: "clawsweeper.action",
      message: "changed",
      payload: { version: 1 },
      now: 456,
    }),
    (error) => {
      assert.equal(
        typeof error === "object" && error && "status" in error ? error.status : undefined,
        409,
      );
      return true;
    },
  );
  assert.equal(archived, false);
});

test("structured session events require bounded identifiers and a versioned object payload", async () => {
  let persisted = false;
  const service = new InteractiveSessionEventLedgerService({
    async persist() {
      persisted = true;
      throw new Error("unexpected persistence");
    },
    async archive() {},
  });
  const cases = [
    { eventKey: "", type: "action", message: "message", payload: { version: 1 } },
    { eventKey: "key", type: "", message: "message", payload: { version: 1 } },
    { eventKey: "key", type: "action", message: "", payload: { version: 1 } },
    { eventKey: "key", type: "action", message: "message", payload: null },
    { eventKey: "key", type: "action", message: "message", payload: [] },
    { eventKey: "key", type: "action", message: "message", payload: {} },
    { eventKey: "key", type: "action", message: "message", payload: { version: 0 } },
  ];
  for (const input of cases) {
    await assert.rejects(
      service.append({
        sessionId: "IS-1",
        actor: "operator",
        ...input,
        now: 123,
      }),
      (error) => {
        assert.equal(
          typeof error === "object" && error && "status" in error ? error.status : undefined,
          400,
        );
        return true;
      },
    );
  }
  assert.equal(persisted, false);
});

test("structured session event payload budgets fail with controlled client errors", async () => {
  let persisted = false;
  const service = new InteractiveSessionEventLedgerService({
    async persist() {
      persisted = true;
      throw new Error("unexpected persistence");
    },
    async archive() {},
  });
  let nested: Record<string, unknown> = {};
  const deepPayload: Record<string, unknown> = { version: 1, nested };
  for (let depth = 0; depth < structuredEventPayloadMaxDepth + 1; depth += 1) {
    const child: Record<string, unknown> = {};
    nested.child = child;
    nested = child;
  }
  const cases: Array<{ payload: Record<string, unknown>; status: number }> = [
    { payload: deepPayload, status: 400 },
    {
      payload: {
        version: 1,
        values: Array.from({ length: structuredEventPayloadMaxMembers }, () => null),
      },
      status: 400,
    },
    {
      payload: {
        version: 1,
        value: "x".repeat(structuredEventPayloadMaxStringBytes + 1),
      },
      status: 400,
    },
    {
      payload: {
        version: 1,
        values: Array.from({ length: 5 }, () =>
          "x".repeat(Math.floor(structuredEventPayloadMaxBytes / 4)),
        ),
      },
      status: 413,
    },
  ];
  for (const { payload, status } of cases) {
    await assert.rejects(
      service.append({
        sessionId: "IS-1",
        actor: "operator",
        eventKey: "run:1",
        type: "clawsweeper.action",
        message: "updated pull request",
        payload,
        now: 123,
      }),
      (error) => {
        assert.equal(
          typeof error === "object" && error && "status" in error ? error.status : undefined,
          status,
        );
        return true;
      },
    );
  }
  assert.equal(persisted, false);
});

test("structured session aggregate budget failures return a controlled client error", async () => {
  let archived = false;
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            return { sql, parameters };
          },
        };
      },
      async batch() {
        throw new Error("D1_ERROR: structured session event budget exceeded");
      },
    } as unknown as D1Database,
  } as RuntimeEnv;

  await assert.rejects(
    appendStructuredInteractiveSessionEventRecord(
      env,
      {
        sessionId: "IS-1",
        actor: "agent",
        eventKey: "run:1",
        type: "clawsweeper.action",
        message: "updated pull request",
        payload: { version: 1 },
        now: 123,
      },
      async () => {
        archived = true;
      },
    ),
    (error) => {
      assert.equal(
        typeof error === "object" && error && "status" in error ? error.status : undefined,
        413,
      );
      assert.match(
        error instanceof Error ? error.message : "",
        new RegExp(`${structuredEventLedgerMaxCount} events.*${structuredEventLedgerMaxBytes}`),
      );
      return true;
    },
  );
  assert.equal(archived, false);
});
