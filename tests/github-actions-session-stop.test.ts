import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubActionsSessionStopService,
  type GitHubActionsSessionStopStore,
} from "../src/worker/github-actions-session-stop.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

function fixture(
  options: {
    persisted?: boolean;
    fail?: "disconnect" | "archive" | "finalize";
  } = {},
) {
  const calls: string[] = [];
  const store: GitHubActionsSessionStopStore = {
    persist: async (session, actor, now) => {
      calls.push(`persist:${session.id}:${actor}:${now}`);
      return options.persisted ?? true;
    },
    disconnect: async (sessionId) => {
      calls.push(`disconnect:${sessionId}`);
      if (options.fail === "disconnect") throw new Error("relay unavailable");
    },
    archive: async (sessionId, now) => {
      calls.push(`archive:${sessionId}:${now}`);
      if (options.fail === "archive") throw new Error("archive unavailable");
    },
    finalize: async (sessionId, now) => {
      calls.push(`finalize:${sessionId}:${now}`);
      if (options.fail === "finalize") throw new Error("finalizer unavailable");
    },
  };
  return {
    calls,
    service: new GitHubActionsSessionStopService(store),
    session: interactiveSession(
      sessionRow({ id: "IS-actions", runtime: "github_actions", capabilities_json: "{}" }),
      [],
    ),
  };
}

test("GitHub Actions stop persists before disconnect, archive, and finalization", async () => {
  const context = fixture();

  assert.equal(await context.service.stop(context.session, "operator", 100), true);
  assert.deepEqual(context.calls, [
    "persist:IS-actions:operator:100",
    "disconnect:IS-actions",
    "archive:IS-actions:100",
    "finalize:IS-actions:100",
  ]);
});

test("GitHub Actions stop performs no cleanup after lost persistence ownership", async () => {
  const context = fixture({ persisted: false });

  assert.equal(await context.service.stop(context.session, "operator", 100), false);
  assert.deepEqual(context.calls, ["persist:IS-actions:operator:100"]);
});

test("GitHub Actions stop keeps cleanup best effort without skipping later stages", async () => {
  for (const failure of ["disconnect", "archive", "finalize"] as const) {
    const context = fixture({ fail: failure });
    assert.equal(await context.service.stop(context.session, "operator", 100), true);
    assert.deepEqual(context.calls, [
      "persist:IS-actions:operator:100",
      "disconnect:IS-actions",
      "archive:IS-actions:100",
      "finalize:IS-actions:100",
    ]);
  }
});
