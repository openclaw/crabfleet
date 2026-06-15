import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  clientDeploymentConfig,
  deploymentConfig,
  selectedRuntimeProfile,
} from "../src/worker/deployment.ts";
import {
  parseRuntimeProfiles,
  resolveRuntimeProfileCodexSsh,
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
        codexSsh: {
          aliasTemplate: "codex-{providerResourceId}",
          setupCommand: ["fleet-connect", "{providerResourceId}"],
        },
      },
      { id: "terminal-b", label: "Terminal B", capabilities: { desktop: false } },
    ]),
  );

  assert.equal(profiles.length, 2);
  assert.equal(runtimeProfileByID(profiles, "desktop-a")?.target, "platform-a");
  assert.deepEqual(runtimeProfileByID(profiles, "desktop-a")?.codexSsh, {
    aliasTemplate: "codex-{providerResourceId}",
    setupCommand: ["fleet-connect", "{providerResourceId}"],
  });
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
    '[{"id":"a","label":"A","capabilities":null}]',
    '[{"id":"a","label":"A","capabilities":{"unknown":true}}]',
    '[{"id":"a","label":"A","privateProvider":"hidden"}]',
    '[{"id":"a","label":"A","codexSsh":null}]',
    '[{"id":"a","label":"A","codexSsh":{"aliasTemplate":"box {sessionId}"}}]',
    '[{"id":"a","label":"A","codexSsh":{"aliasTemplate":"box-{unknown}"}}]',
    '[{"id":"a","label":"A","codexSsh":{"aliasTemplate":"box-{sessionId}","setupCommand":null}}]',
    '[{"id":"a","label":"A","codexSsh":{"aliasTemplate":"box-{sessionId}","setupCommand":["{providerResourceId}"]}}]',
    '[{"id":"a","label":"A","codexSsh":{"aliasTemplate":"box-{sessionId}","setupCommand":["connect","{unknown}"]}}]',
    '[{"id":"a","label":"A","codexSsh":{"aliasTemplate":"box-{sessionId}","setupCommand":["connect","--id={providerResourceId}"]}}]',
    '[{"id":"a","label":"A","codexSsh":{"aliasTemplate":"box-{sessionId}","setupCommand":["connect",";"]}}]',
  ];
  for (const value of invalid) {
    assert.throws(() => parseRuntimeProfiles(value));
  }
  assert.deepEqual(parseRuntimeProfiles(undefined), []);
  assert.deepEqual(parseRuntimeProfiles(""), []);
});

test("runtime profiles resolve bounded manager-only Codex SSH handoff data", async () => {
  const [profile] = parseRuntimeProfiles(
    JSON.stringify([
      {
        id: "linux",
        label: "Linux",
        codexSsh: {
          aliasTemplate: "codex-{providerResourceId}",
          setupCommand: ["fleet-connect", "{providerResourceId}", "--session", "{sessionId}"],
        },
      },
    ]),
  );
  assert.deepEqual(
    resolveRuntimeProfileCodexSsh(profile, {
      providerResourceId: "box-123",
      workspaceId: "tenant-is-1",
      sessionId: "IS-1",
      profile: "linux",
    }),
    {
      alias: "codex-box-123",
      setupCommand: "fleet-connect 'box-123' --session 'IS-1'",
    },
  );
  assert.equal(
    resolveRuntimeProfileCodexSsh(profile, {
      providerResourceId: "cloud/project:box 123",
      workspaceId: "tenant-is-1",
      sessionId: "IS-1",
      profile: "linux",
    }),
    null,
  );

  const [opaqueProviderProfile] = parseRuntimeProfiles(
    JSON.stringify([
      {
        id: "linux",
        label: "Linux",
        codexSsh: {
          aliasTemplate: "codex-{workspaceId}",
          setupCommand: ["fleet-connect", "{providerResourceId}"],
        },
      },
    ]),
  );
  assert.deepEqual(
    resolveRuntimeProfileCodexSsh(opaqueProviderProfile, {
      providerResourceId: "cloud/project:box 123",
      workspaceId: "tenant-is-1",
      sessionId: "IS-1",
      profile: "linux",
    }),
    {
      alias: "codex-tenant-is-1",
      setupCommand: "fleet-connect 'cloud/project:box 123'",
    },
  );
  assert.deepEqual(
    resolveRuntimeProfileCodexSsh(opaqueProviderProfile, {
      providerResourceId: "cloud/project'box",
      workspaceId: "tenant-is-1",
      sessionId: "IS-1",
      profile: "linux",
    }),
    {
      alias: "codex-tenant-is-1",
      setupCommand: "fleet-connect 'cloud/project'\"'\"'box'",
    },
  );
  assert.deepEqual(
    resolveRuntimeProfileCodexSsh(opaqueProviderProfile, {
      providerResourceId: "cloud/{project}/$(command)",
      workspaceId: "tenant-is-1",
      sessionId: "IS-1",
      profile: "linux",
    }),
    {
      alias: "codex-tenant-is-1",
      setupCommand: "fleet-connect 'cloud/{project}/$(command)'",
    },
  );

  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const start = source.indexOf("function decorateInteractiveSession");
  const end = source.indexOf("async function canControlInteractiveSessionById", start);
  const decoration = source.slice(start, end);
  assert.match(decoration, /canManage && codexSshReady/);
  assert.match(decoration, /codexSsh,/);
  assert.match(
    decoration,
    /configuredRuntimeAdapterControlPlane\(env, session\.profile\) ===\s+session\[interactiveSessionAdapterControlPlane\]/,
  );
  const client = clientDeploymentConfig({
    CRABFLEET_DEFAULT_PROFILE: "linux",
    CRABFLEET_RUNTIME_PROFILES_JSON: JSON.stringify([
      {
        id: "linux",
        label: "Linux",
        codexSsh: {
          aliasTemplate: "codex-{providerResourceId}",
          setupCommand: ["fleet-connect", "{providerResourceId}"],
        },
      },
    ]),
  });
  assert.equal(client.runtimeProfiles[0]?.codexSsh, undefined);
});

test("profile allowlisting and capability withdrawals stay enforced at provisioning", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const selectionStart = source.indexOf("const profile = clean(body.profile");
  assert.equal(selectionStart, -1);
  const deployment = deploymentConfig({
    CRABFLEET_DEFAULT_PROFILE: "linux",
    CRABFLEET_RUNTIME_PROFILES_JSON: JSON.stringify([{ id: "linux", label: "Linux" }]),
  });
  assert.equal(selectedRuntimeProfile(deployment, "linux").descriptor?.id, "linux");
  assert.throws(() => selectedRuntimeProfile(deployment, "unknown"), /profile is not configured/);
  assert.ok(source.indexOf("selectedRuntimeProfile(deploymentConfig(env), session.profile)") > 0);

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
