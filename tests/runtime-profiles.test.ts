import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  parseRuntimeProfiles,
  runtimeProfileByID,
  runtimeProfileCapabilities,
} from "../src/runtime-profiles.ts";

test("runtime profile catalog preserves generic labels, targets, and capabilities", () => {
  const profiles = parseRuntimeProfiles(
    JSON.stringify([
      {
        id: "desktop-a",
        label: "Desktop A",
        target: "platform-a",
        capabilities: { terminal: true, desktop: true, vnc: true },
      },
      { id: "terminal-b", label: "Terminal B", capabilities: { desktop: false } },
    ]),
  );

  assert.equal(profiles.length, 2);
  assert.equal(runtimeProfileByID(profiles, "desktop-a")?.target, "platform-a");
  assert.deepEqual(
    runtimeProfileCapabilities(runtimeProfileByID(profiles, "terminal-b"), {
      terminal: true,
      takeover: false,
      vnc: true,
      desktop: true,
      logs: true,
      artifacts: false,
    }),
    {
      terminal: true,
      takeover: false,
      vnc: true,
      desktop: false,
      logs: true,
      artifacts: false,
    },
  );
});

test("runtime profile catalog fails closed on malformed or ambiguous input", () => {
  const invalid = [
    " ",
    "{}",
    "[]",
    '[{"id":"a","label":"A"},{"id":"a","label":"B"}]',
    '[{"id":"a","label":"Same"},{"id":"b","label":"same"}]',
    '[{"id":"a","label":" A"}]',
    '[{"id":"a","label":"A\\nB"}]',
    '[{"id":"a","label":"A","capabilities":{"desktop":"yes"}}]',
    '[{"id":"a","label":"A","capabilities":{"unknown":true}}]',
    '[{"id":"a","label":"A","privateProvider":"hidden"}]',
  ];
  for (const value of invalid) {
    assert.throws(() => parseRuntimeProfiles(value));
  }
  assert.deepEqual(parseRuntimeProfiles(undefined), []);
  assert.deepEqual(parseRuntimeProfiles(""), []);
});

test("profile allowlisting and capability withdrawals stay enforced at provisioning", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const selectionStart = source.indexOf("const profile = clean(body.profile");
  const selectionEnd = source.indexOf("const command = interactiveCommand", selectionStart);
  const selection = source.slice(selectionStart, selectionEnd);
  assert.match(selection, /deployment\.runtimeProfiles\.length > 0 && !runtimeProfile/);

  const resultStart = source.indexOf("function runtimeAdapterProvisionResult");
  const resultEnd = source.indexOf(
    "async function reconcileStoppingRuntimeAdapterWorkspace",
    resultStart,
  );
  const result = source.slice(resultStart, resultEnd);
  assert.match(
    result,
    /session\.adapterRequestedCapabilities \?\?[\s\S]*session\.capabilities_json/,
  );
});
