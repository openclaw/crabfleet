import assert from "node:assert/strict";
import test from "node:test";

import {
  interactiveAccessDialog,
  interactiveShareDialog,
  interactiveStopDialog,
  presentInteractiveShareLink,
  removeInteractiveSessionState,
  replaceCardState,
  upsertInteractiveSessionState,
} from "../src/app/app-mutations.js";

test("app mutation state helpers replace, insert, and remove owned records", () => {
  const state = {
    cards: [
      { id: "CY-1", title: "Before" },
      { id: "CY-2", title: "Other" },
    ],
    interactiveSessions: [{ id: "IS-1", status: "ready" }],
  };

  assert.deepEqual(replaceCardState(state, { id: "CY-1", title: "After" }).cards, [
    { id: "CY-1", title: "After" },
    { id: "CY-2", title: "Other" },
  ]);
  assert.deepEqual(
    upsertInteractiveSessionState(state, { id: "IS-1", status: "stopped" }).interactiveSessions,
    [{ id: "IS-1", status: "stopped" }],
  );
  assert.deepEqual(
    upsertInteractiveSessionState(state, { id: "IS-2", status: "ready" }).interactiveSessions,
    [
      { id: "IS-2", status: "ready" },
      { id: "IS-1", status: "ready" },
    ],
  );
  assert.deepEqual(removeInteractiveSessionState(state, "IS-1").interactiveSessions, []);
});

test("interactive stop dialogs distinguish workspace deletion and workflow detachment", () => {
  assert.deepEqual(
    interactiveStopDialog(
      {
        id: "IS-1",
        repo: "openclaw/crabfleet",
        adapter: "runtime-v1",
      },
      "IS-1",
    ),
    {
      kind: "danger",
      eyebrow: "Live workspace",
      title: "Delete Crabbox workspace?",
      description:
        "This releases the runtime workspace and cannot be undone. Its final status and logs stay visible in Crabfleet.",
      subject: "openclaw/crabfleet (IS-1)",
      confirmLabel: "Delete workspace",
    },
  );

  const workflow = interactiveStopDialog(
    {
      id: "IS-2",
      repo: "openclaw/crabfleet",
      runtime: "github_actions",
    },
    "IS-2",
  );
  assert.equal(workflow.title, "End GitHub Actions terminal session?");
  assert.equal(workflow.confirmLabel, "End session");
  assert.match(workflow.description, /does not cancel the GitHub Actions workflow run/);

  const fallback = interactiveStopDialog(null, "IS-3");
  assert.equal(fallback.title, "Stop Crabbox session?");
  assert.equal(fallback.confirmLabel, "Stop session");
  assert.match(fallback.description, /releases the managed Sandbox resources/);
});

test("interactive sharing always presents a visible HTML dialog", async () => {
  const actions: Array<[string, string]> = [];
  const dialogs: unknown[] = [];
  const result = await presentInteractiveShareLink(
    "IS-4",
    async (id, action) => {
      actions.push([id, action]);
      return { shareUrl: "https://crabfleet.openclaw.ai/share/IS-4?token=redacted" };
    },
    (dialog) => dialogs.push(dialog),
  );

  assert.deepEqual(actions, [["IS-4", "share_link"]]);
  assert.equal(result.shareUrl, "https://crabfleet.openclaw.ai/share/IS-4?token=redacted");
  assert.deepEqual(dialogs, [
    interactiveShareDialog("https://crabfleet.openclaw.ai/share/IS-4?token=redacted"),
  ]);
});

test("interactive sharing does not open an empty dialog", async () => {
  const dialogs: unknown[] = [];
  await presentInteractiveShareLink(
    "IS-5",
    async () => ({}),
    (dialog) => dialogs.push(dialog),
  );
  assert.deepEqual(dialogs, []);
});

test("interactive named access dialogs retain grant and revocation actions", async () => {
  const actions: unknown[] = [];
  const grants = [
    {
      subject: "proxy:collaborator@example.test",
      principal: "collaborator@example.test",
      role: "viewer",
      expiresAt: 200,
    },
  ];
  const dialog = interactiveAccessDialog(
    grants,
    async (input) => actions.push(["grant", input]),
    async (subject) => actions.push(["revoke", subject]),
  );

  assert.equal(dialog.kind, "access");
  assert.equal(dialog.confirmLabel, "Grant access");
  assert.equal(dialog.grants, grants);
  await dialog.action({
    principal: "collaborator@example.test",
    role: "controller",
    expiresInSeconds: 3600,
  });
  await dialog.revoke("proxy:collaborator@example.test");
  assert.deepEqual(actions, [
    [
      "grant",
      {
        principal: "collaborator@example.test",
        role: "controller",
        expiresInSeconds: 3600,
      },
    ],
    ["revoke", "proxy:collaborator@example.test"],
  ]);
});
