import {
  encodeGitHubActionsRelayOutput,
  parseGitHubActionsRelayInput,
  sendGitHubActionsRelayInputAcknowledgement,
  type GitHubActionsRelaySocket,
} from "./github-actions-runtime.ts";

const runnerInputQueueMaxBytes = 16 * 1024 * 1024;
const runnerInputQueueMaxFrames = 32;
const runnerInputQueueMaxAgeMs = 5_000;
const runnerInputBacklogError = "GitHub Actions runner input backlog exceeded";
const runnerInputExpiredError = "GitHub Actions runner input expired";
const runnerInputGenerationError = "GitHub Actions runner generation changed";

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
      try {
        await writeToPty(input.payload);
        if (isActiveRunnerInputQueue(socket, queue)) {
          sendRunnerInputAcknowledgement(socket, input.inputId, input.generation, true);
        }
      } catch {
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
  return queued
    .finally(() => {
      deleteIdleRunnerInputQueue(socket, queue, queued);
    })
    .then(() => true);
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

function deleteIdleRunnerInputQueue(
  socket: GitHubActionsRelaySocket,
  queue: RunnerInputQueue,
  tail: Promise<void>,
): void {
  if (runnerInputQueues.get(socket) === queue && queue.tail === tail && queue.frames === 0) {
    runnerInputQueues.delete(socket);
  }
}
