import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptGitHubActionsRunnerInput,
  sendGitHubActionsRunnerOutput,
} from "../src/github-actions-runner.ts";
import {
  encodeGitHubActionsRelayInput,
  parseGitHubActionsRelayOutput,
  parseGitHubActionsRelayInputAcknowledgement,
  type GitHubActionsRelaySocket,
} from "../src/github-actions-runtime.ts";

function relaySocket(): GitHubActionsRelaySocket & {
  closes: Array<{ code: number | undefined; reason: string | undefined }>;
  sent: Array<string | ArrayBuffer>;
} {
  return {
    readyState: WebSocket.OPEN,
    closes: [],
    sent: [],
    send(message) {
      this.sent.push(message);
    },
    close(code, reason) {
      this.closes.push({ code, reason });
      this.readyState = WebSocket.CLOSED;
    },
  };
}

test("runner acknowledges input only after the PTY write completes", async () => {
  const socket = relaySocket();
  let completeWrite!: () => void;
  const write = new Promise<void>((resolve) => {
    completeWrite = resolve;
  });
  const handled = acceptGitHubActionsRunnerInput(
    socket,
    encodeGitHubActionsRelayInput("input-one", "steer"),
    async (payload) => {
      assert.equal(new TextDecoder().decode(payload), "steer");
      await write;
    },
  );

  await Promise.resolve();
  assert.deepEqual(socket.sent, []);
  completeWrite();
  assert.equal(await handled, true);
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(socket.sent[0]!), {
    inputId: "input-one",
    accepted: true,
  });
});

test("runner serializes concurrent input writes and acknowledgements per socket", async () => {
  const socket = relaySocket();
  const writes: string[] = [];
  let completeFirstWrite!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    completeFirstWrite = resolve;
  });

  const first = acceptGitHubActionsRunnerInput(
    socket,
    encodeGitHubActionsRelayInput("input-first", "first"),
    async (payload) => {
      writes.push(`${new TextDecoder().decode(payload)}:start`);
      await firstWrite;
      writes.push("first:end");
    },
  );
  const second = acceptGitHubActionsRunnerInput(
    socket,
    encodeGitHubActionsRelayInput("input-second", "second"),
    async (payload) => {
      writes.push(new TextDecoder().decode(payload));
    },
  );

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(writes, ["first:start"]);
  assert.deepEqual(socket.sent, []);

  completeFirstWrite();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(writes, ["first:start", "first:end", "second"]);
  assert.deepEqual(
    socket.sent.map((message) => parseGitHubActionsRelayInputAcknowledgement(message)),
    [
      { inputId: "input-first", accepted: true },
      { inputId: "input-second", accepted: true },
    ],
  );
});

test("runner bounds queued frames and rejects overflow without extending a stalled tail", async () => {
  const socket = relaySocket();
  let completeFirstWrite!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    completeFirstWrite = resolve;
  });
  const writes: number[] = [];
  const pending = Array.from({ length: 33 }, (_, index) =>
    acceptGitHubActionsRunnerInput(
      socket,
      encodeGitHubActionsRelayInput(`input-${index}`, new Uint8Array([index])),
      async (payload) => {
        writes.push(new Uint8Array(payload)[0]!);
        if (index === 0) await firstWrite;
      },
    ),
  );

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(writes, [0]);
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(socket.sent[0]!), {
    inputId: "input-32",
    accepted: false,
    error: "GitHub Actions runner input backlog exceeded",
  });
  completeFirstWrite();
  assert.deepEqual(await Promise.all(pending), Array(33).fill(true));
  assert.deepEqual(
    writes,
    Array.from({ length: 32 }, (_, index) => index),
  );
  assert.deepEqual(
    socket.sent.map((message) => parseGitHubActionsRelayInputAcknowledgement(message)),
    [
      {
        inputId: "input-32",
        accepted: false,
        error: "GitHub Actions runner input backlog exceeded",
      },
      ...Array.from({ length: 32 }, (_, index) => ({
        inputId: `input-${index}`,
        accepted: true,
      })),
    ],
  );
});

test("runner keeps overflow floods off the accepted input queue", async () => {
  const socket = relaySocket();
  let completeFirstWrite!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    completeFirstWrite = resolve;
  });
  const writes: number[] = [];
  const accepted = Array.from({ length: 32 }, (_, index) =>
    acceptGitHubActionsRunnerInput(
      socket,
      encodeGitHubActionsRelayInput(`accepted-${index}`, new Uint8Array([index])),
      async (payload) => {
        writes.push(new Uint8Array(payload)[0]!);
        if (index === 0) await firstWrite;
      },
    ),
  );

  let settledOverflows = 0;
  const overflows = Array.from({ length: 512 }, (_, index) =>
    acceptGitHubActionsRunnerInput(
      socket,
      encodeGitHubActionsRelayInput(`overflow-${index}`, new Uint8Array([index])),
      async () => {
        assert.fail("overflow input must not reach the PTY");
      },
    ).then((handled) => {
      settledOverflows += 1;
      return handled;
    }),
  );

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settledOverflows, 512);
  assert.deepEqual(await Promise.all(overflows), Array(512).fill(true));
  assert.deepEqual(writes, [0]);

  completeFirstWrite();
  assert.deepEqual(await Promise.all(accepted), Array(32).fill(true));
  assert.deepEqual(
    writes,
    Array.from({ length: 32 }, (_, index) => index),
  );
  assert.equal(socket.sent.length, 544);
});

test("runner bounds queued bytes while a PTY write is stalled", async () => {
  const socket = relaySocket();
  let completeFirstWrite!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    completeFirstWrite = resolve;
  });
  let writes = 0;
  const first = acceptGitHubActionsRunnerInput(
    socket,
    encodeGitHubActionsRelayInput("input-first", new Uint8Array(9 * 1024 * 1024)),
    async () => {
      writes += 1;
      await firstWrite;
    },
  );
  const overflow = acceptGitHubActionsRunnerInput(
    socket,
    encodeGitHubActionsRelayInput("input-overflow", new Uint8Array(8 * 1024 * 1024)),
    async () => {
      writes += 1;
    },
  );

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(writes, 1);
  assert.equal(await overflow, true);
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(socket.sent[0]!), {
    inputId: "input-overflow",
    accepted: false,
    error: "GitHub Actions runner input backlog exceeded",
  });
  completeFirstWrite();
  assert.equal(await first, true);
  assert.equal(writes, 1);
  assert.deepEqual(
    socket.sent.map((message) => parseGitHubActionsRelayInputAcknowledgement(message)),
    [
      {
        inputId: "input-overflow",
        accepted: false,
        error: "GitHub Actions runner input backlog exceeded",
      },
      { inputId: "input-first", accepted: true },
    ],
  );
});

test("runner does not execute queued input after its socket is replaced", async () => {
  const replaced = relaySocket();
  const replacement = relaySocket();
  let completeBlockedWrite!: () => void;
  const blockedWrite = new Promise<void>((resolve) => {
    completeBlockedWrite = resolve;
  });
  const writes: string[] = [];
  const first = acceptGitHubActionsRunnerInput(
    replaced,
    encodeGitHubActionsRelayInput("old-first", "old-first", "old-generation"),
    async (payload) => {
      writes.push(`${new TextDecoder().decode(payload)}:start`);
      await blockedWrite;
      writes.push("old-first:end");
    },
  );
  const queued = acceptGitHubActionsRunnerInput(
    replaced,
    encodeGitHubActionsRelayInput("old-queued", "old-queued", "old-generation"),
    async (payload) => {
      writes.push(new TextDecoder().decode(payload));
    },
  );

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(writes, ["old-first:start"]);
  replaced.close(1012, "runner replaced");
  const current = acceptGitHubActionsRunnerInput(
    replacement,
    encodeGitHubActionsRelayInput("new-input", "new-input", "new-generation"),
    async (payload) => {
      writes.push(new TextDecoder().decode(payload));
    },
  );
  assert.equal(await current, true);

  completeBlockedWrite();
  assert.deepEqual(await Promise.all([first, queued]), [true, true]);
  assert.deepEqual(writes, ["old-first:start", "new-input", "old-first:end"]);
  assert.deepEqual(replaced.sent, []);
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(replacement.sent[0]!), {
    inputId: "new-input",
    accepted: true,
    generation: "new-generation",
  });
});

test("runner retires queued input when its relay generation changes", async () => {
  const socket = relaySocket();
  let completeBlockedWrite!: () => void;
  const blockedWrite = new Promise<void>((resolve) => {
    completeBlockedWrite = resolve;
  });
  const writes: string[] = [];
  const first = acceptGitHubActionsRunnerInput(
    socket,
    encodeGitHubActionsRelayInput("first", "first", "generation-one"),
    async (payload) => {
      writes.push(new TextDecoder().decode(payload));
      await blockedWrite;
    },
  );
  const queued = acceptGitHubActionsRunnerInput(
    socket,
    encodeGitHubActionsRelayInput("queued", "queued", "generation-one"),
    async (payload) => {
      writes.push(new TextDecoder().decode(payload));
    },
  );

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    await acceptGitHubActionsRunnerInput(
      socket,
      encodeGitHubActionsRelayInput("replacement", "replacement", "generation-two"),
      async () => {
        assert.fail("replacement input must not reach the retired socket");
      },
    ),
    true,
  );
  assert.deepEqual(socket.closes, [
    { code: 1012, reason: "GitHub Actions runner generation changed" },
  ]);

  completeBlockedWrite();
  assert.deepEqual(await Promise.all([first, queued]), [true, true]);
  assert.deepEqual(writes, ["first"]);
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(socket.sent[0]!), {
    inputId: "replacement",
    accepted: false,
    error: "GitHub Actions runner generation changed",
    generation: "generation-two",
  });
});

test("runner rejects queued input that outlives the viewer acknowledgement timeout", async () => {
  const socket = relaySocket();
  let completeFirstWrite!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    completeFirstWrite = resolve;
  });
  let now = 0;
  const writes: string[] = [];
  const first = acceptGitHubActionsRunnerInput(
    socket,
    encodeGitHubActionsRelayInput("input-first", "first"),
    async (payload) => {
      writes.push(new TextDecoder().decode(payload));
      await firstWrite;
    },
    () => now,
  );
  const expired = acceptGitHubActionsRunnerInput(
    socket,
    encodeGitHubActionsRelayInput("input-expired", "expired"),
    async (payload) => {
      writes.push(new TextDecoder().decode(payload));
    },
    () => now,
  );

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(writes, ["first"]);
  now = 5_000;
  completeFirstWrite();
  assert.deepEqual(await Promise.all([first, expired]), [true, true]);
  assert.deepEqual(writes, ["first"]);
  assert.deepEqual(
    socket.sent.map((message) => parseGitHubActionsRelayInputAcknowledgement(message)),
    [
      { inputId: "input-first", accepted: true },
      {
        inputId: "input-expired",
        accepted: false,
        error: "GitHub Actions runner input expired",
      },
    ],
  );
});

test("runner copies the relay generation into its acknowledgement", async () => {
  const socket = relaySocket();

  assert.equal(
    await acceptGitHubActionsRunnerInput(
      socket,
      encodeGitHubActionsRelayInput("input-generated", "steer", "generation-one"),
      async () => {},
    ),
    true,
  );
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(socket.sent[0]!), {
    inputId: "input-generated",
    accepted: true,
    generation: "generation-one",
  });
});

test("runner retains its relay generation after the input queue drains", async () => {
  const socket = relaySocket();
  const writes: string[] = [];

  assert.equal(
    await acceptGitHubActionsRunnerInput(
      socket,
      encodeGitHubActionsRelayInput("first", "first", "generation-one"),
      async (payload) => {
        writes.push(new TextDecoder().decode(payload));
      },
    ),
    true,
  );
  assert.equal(
    await acceptGitHubActionsRunnerInput(
      socket,
      encodeGitHubActionsRelayInput("replacement", "replacement", "generation-two"),
      async () => {
        assert.fail("replacement input must not reach the PTY after the queue drains");
      },
    ),
    true,
  );

  assert.deepEqual(writes, ["first"]);
  assert.deepEqual(socket.closes, [
    { code: 1012, reason: "GitHub Actions runner generation changed" },
  ]);
  assert.deepEqual(
    socket.sent.map((message) => parseGitHubActionsRelayInputAcknowledgement(message)),
    [
      { inputId: "first", accepted: true, generation: "generation-one" },
      {
        inputId: "replacement",
        accepted: false,
        error: "GitHub Actions runner generation changed",
        generation: "generation-two",
      },
    ],
  );
});

test("runner rejects failed writes and ignores unframed terminal data", async () => {
  const socket = relaySocket();

  assert.equal(
    await acceptGitHubActionsRunnerInput(
      socket,
      encodeGitHubActionsRelayInput("input-two", "steer"),
      async () => {
        throw new Error("PTY closed");
      },
    ),
    true,
  );
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(socket.sent[0]!), {
    inputId: "input-two",
    accepted: false,
    error: "GitHub Actions runner did not accept terminal input",
  });
  assert.equal(await acceptGitHubActionsRunnerInput(socket, "raw input", async () => {}), false);
  assert.equal(socket.sent.length, 1);
});

test("runner output helper envelopes PTY bytes for connection-negotiated runners", () => {
  const socket = relaySocket();

  const collision = encodeGitHubActionsRelayInput("looks-like-input", "terminal bytes");
  sendGitHubActionsRunnerOutput(socket, collision);
  assert.deepEqual(
    new Uint8Array(parseGitHubActionsRelayOutput(socket.sent[0]!)!),
    new Uint8Array(collision),
  );
});
