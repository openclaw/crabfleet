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

type RunnerInputQueue = {
  bytes: number;
  frames: number;
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

  const queue = runnerInputQueues.get(socket) ?? {
    bytes: 0,
    frames: 0,
    tail: Promise.resolve(),
  };
  runnerInputQueues.set(socket, queue);

  if (
    queue.frames >= runnerInputQueueMaxFrames ||
    queue.bytes + input.payload.byteLength > runnerInputQueueMaxBytes
  ) {
    const { generation, inputId } = input;
    const rejected = queue.tail
      .catch(() => undefined)
      .then(() => {
        sendRunnerInputAcknowledgement(socket, inputId, generation, false, runnerInputBacklogError);
      });
    queue.tail = rejected;
    return rejected
      .finally(() => {
        deleteIdleRunnerInputQueue(socket, queue, rejected);
      })
      .then(() => true);
  }

  const queuedAt = now();
  queue.frames += 1;
  queue.bytes += input.payload.byteLength;
  const queued = queue.tail
    .catch(() => undefined)
    .then(async () => {
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
        sendRunnerInputAcknowledgement(socket, input.inputId, input.generation, true);
      } catch {
        sendRunnerInputAcknowledgement(socket, input.inputId, input.generation, false);
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

function deleteIdleRunnerInputQueue(
  socket: GitHubActionsRelaySocket,
  queue: RunnerInputQueue,
  tail: Promise<void>,
): void {
  if (runnerInputQueues.get(socket) === queue && queue.tail === tail && queue.frames === 0) {
    runnerInputQueues.delete(socket);
  }
}
