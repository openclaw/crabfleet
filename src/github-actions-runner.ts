import {
  encodeGitHubActionsRelayOutput,
  parseGitHubActionsRelayInput,
  sendGitHubActionsRelayInputAcknowledgement,
  type GitHubActionsRelaySocket,
} from "./github-actions-runtime.ts";

const runnerInputQueueMaxBytes = 16 * 1024 * 1024;
const runnerInputQueueMaxFrames = 32;
const runnerInputQueueMaxAgeMs = 5_000;
const runnerInputWriteTimeoutMs = 5_000;
const runnerInputBacklogError = "GitHub Actions runner input backlog exceeded";
const runnerInputExpiredError = "GitHub Actions runner input expired";
const runnerInputGenerationError = "GitHub Actions runner generation changed";
const runnerInputWriteTimeoutError = "GitHub Actions runner input write timed out";

type RunnerInputQueue = {
  bytes: number;
  frames: number;
  generation: string | undefined;
  retired: boolean;
  tail: Promise<void>;
};

const runnerInputQueues = new WeakMap<GitHubActionsRelaySocket, RunnerInputQueue>();

export function sendGitHubActionsRunnerOutput(
  socket: GitHubActionsRelaySocket,
  output: string | ArrayBuffer | ArrayBufferView,
): void {
  socket.send(encodeGitHubActionsRelayOutput(output));
}

export function acceptGitHubActionsRunnerInput(
  socket: GitHubActionsRelaySocket,
  message: string | ArrayBuffer,
  writeToPty: (payload: ArrayBuffer) => void | Promise<void>,
  now: () => number = Date.now,
  writeTimeoutMs: number = runnerInputWriteTimeoutMs,
): Promise<boolean> {
  const input = parseGitHubActionsRelayInput(message);
  if (!input) return Promise.resolve(false);

  const existingQueue = runnerInputQueues.get(socket);
  if (existingQueue?.retired || socket.readyState !== WebSocket.OPEN) {
    return Promise.resolve(true);
  }
  if (existingQueue && existingQueue.generation !== input.generation) {
    existingQueue.retired = true;
    sendRunnerInputAcknowledgement(
      socket,
      input.inputId,
      input.generation,
      false,
      runnerInputGenerationError,
    );
    closeRunnerInputSocket(socket, runnerInputGenerationError);
    return Promise.resolve(true);
  }

  const queue =
    existingQueue ??
    ({
      bytes: 0,
      frames: 0,
      generation: input.generation,
      retired: false,
      tail: Promise.resolve(),
    } satisfies RunnerInputQueue);
  if (!existingQueue) runnerInputQueues.set(socket, queue);

  if (
    queue.frames >= runnerInputQueueMaxFrames ||
    queue.bytes + input.payload.byteLength > runnerInputQueueMaxBytes
  ) {
    sendRunnerInputAcknowledgement(
      socket,
      input.inputId,
      input.generation,
      false,
      runnerInputBacklogError,
    );
    return Promise.resolve(true);
  }

  const queuedAt = now();
  queue.frames += 1;
  queue.bytes += input.payload.byteLength;
  const queued = queue.tail
    .catch(() => undefined)
    .then(async () => {
      if (!isActiveRunnerInputQueue(socket, queue)) return;
      if (now() - queuedAt >= runnerInputQueueMaxAgeMs) {
        sendRunnerInputAcknowledgement(
          socket,
          input.inputId,
          input.generation,
          false,
          runnerInputExpiredError,
        );
        return;
      }
      const writeResult = await writeRunnerInputWithTimeout(
        () => writeToPty(input.payload),
        writeTimeoutMs,
      );
      if (writeResult === "timed-out") {
        queue.retired = true;
        closeRunnerInputSocket(socket, runnerInputWriteTimeoutError);
        return;
      }
      if (writeResult === "accepted") {
        if (isActiveRunnerInputQueue(socket, queue)) {
          sendRunnerInputAcknowledgement(socket, input.inputId, input.generation, true);
        }
      } else {
        if (isActiveRunnerInputQueue(socket, queue)) {
          sendRunnerInputAcknowledgement(socket, input.inputId, input.generation, false);
        }
      }
    })
    .finally(() => {
      queue.frames -= 1;
      queue.bytes -= input.payload.byteLength;
    });
  queue.tail = queued;
  return queued.then(() => true);
}

function writeRunnerInputWithTimeout(
  write: () => void | Promise<void>,
  timeoutMs: number,
): Promise<"accepted" | "rejected" | "timed-out"> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: "accepted" | "rejected" | "timed-out") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish("timed-out"), timeoutMs);
    let result: void | Promise<void>;
    try {
      result = write();
    } catch {
      finish("rejected");
      return;
    }
    Promise.resolve(result).then(
      () => finish("accepted"),
      () => finish("rejected"),
    );
  });
}

function sendRunnerInputAcknowledgement(
  socket: GitHubActionsRelaySocket,
  inputId: string,
  generation: string | undefined,
  accepted: boolean,
  error?: string,
): void {
  sendGitHubActionsRelayInputAcknowledgement(socket, {
    inputId,
    accepted,
    ...(error ? { error } : {}),
    ...(generation ? { generation } : {}),
  });
}

function closeRunnerInputSocket(socket: GitHubActionsRelaySocket, reason: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.close(1012, reason);
  } catch {
    // Queue retirement still prevents later writes when the socket cannot be closed cleanly.
  }
}

function isActiveRunnerInputQueue(
  socket: GitHubActionsRelaySocket,
  queue: RunnerInputQueue,
): boolean {
  if (
    runnerInputQueues.get(socket) !== queue ||
    queue.retired ||
    socket.readyState !== WebSocket.OPEN
  ) {
    queue.retired = true;
    return false;
  }
  return true;
}
