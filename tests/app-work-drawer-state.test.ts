import assert from "node:assert/strict";
import test from "node:test";

import { interactiveCreationDefaults, runCapabilitySummary } from "../src/app/work-drawer-state.js";

test("interactive creation defaults follow deployment policy", () => {
  const profiles = [{ id: "large" }];
  assert.deepEqual(
    interactiveCreationDefaults({
      defaultRuntime: "crabbox",
      interactiveRuntimes: ["crabbox"],
      defaultProfile: "large",
      runtimeProfiles: profiles,
    }),
    {
      runtime: "crabbox",
      runtimes: [{ id: "crabbox", label: "Crabbox" }],
      profile: "large",
      profiles,
    },
  );
  assert.deepEqual(interactiveCreationDefaults(null), {
    runtime: "container",
    runtimes: [
      { id: "container", label: "Cloudflare Sandbox" },
      { id: "crabbox", label: "Crabbox" },
    ],
    profile: "default",
    profiles: [],
  });
});

test("run capability summaries expose only enabled capabilities", () => {
  const result = runCapabilitySummary({
    runtime: "github_actions",
    run: { capabilities: { takeover: true, steer: true, vnc: false } },
  });
  assert.equal(result.label.includes("takeover"), true);
  assert.equal(result.label.includes("steer"), true);
  assert.equal(result.label.includes("vnc"), false);
});
