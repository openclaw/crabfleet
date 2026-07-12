import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const lockWaitMs = 120_000;
const lockPortBase = 49_152;
const lockPortRange = 65_535 - lockPortBase + 1;
const lockPort =
  lockPortBase +
  (createHash("sha256")
    .update(fileURLToPath(new URL("../../", import.meta.url)))
    .digest()
    .readUInt16BE(0) %
    lockPortRange);

export async function withGeneratedAssetsForTest<T>(consume: () => T | Promise<T>): Promise<T> {
  const lock = await acquireLock();
  try {
    await execFileAsync(process.execPath, ["scripts/generate-assets.mjs"]);
    return await consume();
  } finally {
    await closeServer(lock);
  }
}

async function acquireLock(): Promise<Server> {
  const deadline = Date.now() + lockWaitMs;
  while (true) {
    const server = createServer();
    try {
      await listen(server);
      return server;
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
      if (Date.now() >= deadline)
        throw new Error("timed out waiting for generated asset test lock");
      await delay(50);
    }
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: lockPort, exclusive: true }, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}
