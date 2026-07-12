import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const lockParent = new URL("../../dist/", import.meta.url);
const lockPath = new URL("../../dist/.generated-assets-test.lock/", import.meta.url);
const lockWaitMs = 120_000;
const staleLockMs = 300_000;

export async function generateAssetsForTest(): Promise<void> {
  await mkdir(lockParent, { recursive: true });
  const deadline = Date.now() + lockWaitMs;
  while (!(await tryAcquireLock())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for generated asset test lock");
    await delay(50);
  }

  try {
    await execFileAsync(process.execPath, ["scripts/generate-assets.mjs"]);
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function tryAcquireLock(): Promise<boolean> {
  try {
    await mkdir(lockPath);
    return true;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    try {
      const lock = await stat(lockPath);
      if (Date.now() - lock.mtimeMs > staleLockMs) {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch (lockError) {
      if (!isMissing(lockError)) throw lockError;
    }
    return false;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
