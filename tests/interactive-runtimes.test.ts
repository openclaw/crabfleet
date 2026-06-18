import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configurableInteractiveRuntimeOptions,
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

test("interactive runtime options provide one shared server and drawer catalog", () => {
  assert.deepEqual(configurableInteractiveRuntimeOptions, [
    { id: "container", label: "Cloudflare Sandbox" },
    { id: "crabbox", label: "Crabbox" },
  ]);
});
