import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  defaultInteractiveRuntime,
  parseInteractiveRuntimes,
} from "../src/interactive-runtimes.ts";

test("interactive runtimes retain both existing choices by default", () => {
  assert.deepEqual(parseInteractiveRuntimes(undefined), ["container", "crabbox"]);
  assert.deepEqual(parseInteractiveRuntimes(""), ["container", "crabbox"]);
  assert.equal(defaultInteractiveRuntime(undefined, ["container", "crabbox"]), "container");
});

test("interactive runtimes support a Crabbox-only deployment", () => {
  const runtimes = parseInteractiveRuntimes("crabbox");
  assert.deepEqual(runtimes, ["crabbox"]);
  assert.equal(defaultInteractiveRuntime(undefined, runtimes), "crabbox");
  assert.equal(defaultInteractiveRuntime("crabbox", runtimes), "crabbox");
});

test("interactive runtime configuration fails closed", () => {
  for (const value of [" ", "container, crabbox", "container,container", "github_actions"]) {
    assert.throws(() => parseInteractiveRuntimes(value));
  }
  assert.throws(() => defaultInteractiveRuntime(undefined, []));
  assert.throws(() => defaultInteractiveRuntime("container", ["crabbox"]));
  assert.throws(() => defaultInteractiveRuntime("unknown", ["container", "crabbox"]));
});

test("interactive runtime allowlist controls both API and drawer", async () => {
  const worker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app/main.jsx", import.meta.url), "utf8");

  assert.match(worker, /deployment\.interactiveRuntimes\.includes\(requestedRuntime/);
  assert.match(worker, /runtime is not enabled for interactive sessions/);
  assert.match(app, /state\.deployment\?\.interactiveRuntimes/);
  assert.match(app, /runtimeOptions\.length > 1/);
  assert.match(app, /type="hidden" name="runtime" value=\{defaultRuntime\}/);
});
