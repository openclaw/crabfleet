import assert from "node:assert/strict";
import test from "node:test";

import type { UpdateObject } from "kysely";

import type { Database } from "../src/worker/database.ts";
import type { HttpError } from "../src/worker/http.ts";
import {
  InteractiveSessionMetadataService,
  isInteractiveSessionMetadataAction,
  type InteractiveSessionMetadataAction,
  type InteractiveSessionMetadataPolicy,
  type InteractiveSessionMetadataStore,
} from "../src/worker/session-metadata.ts";
import { interactiveSession, type InteractiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

type PersistedMutation = {
  actor: string;
  message: string;
  values: UpdateObject<Database, "interactive_sessions">;
  now: number;
};

function fixture(
  options: {
    session?: InteractiveSession;
    readSession?: InteractiveSession | null;
    persist?: boolean;
    archiveFailure?: boolean;
  } = {},
) {
  const session =
    options.session ??
    interactiveSession(sessionRow({ id: "IS-7", owner: "owner", updated_at: 20 }), []);
  const mutations: PersistedMutation[] = [];
  const audits: string[] = [];
  const archives: string[] = [];
  const store: InteractiveSessionMetadataStore = {
    persist: async (_session, actor, message, values, now) => {
      mutations.push({ actor, message, values, now });
      return options.persist ?? true;
    },
    archive: async (sessionId) => {
      archives.push(sessionId);
      if (options.archiveFailure) throw new Error("archive unavailable");
    },
    audit: async (message) => {
      audits.push(message);
    },
    readSession: async () => (options.readSession === undefined ? session : options.readSession),
  };
  const service = new InteractiveSessionMetadataService(
    store,
    () => "12345678share-token",
    async (token) => `hash:${token}`,
  );
  return { archives, audits, mutations, service, session };
}

const allowedPolicy: InteractiveSessionMetadataPolicy = {
  canManage: true,
  canChangeMultiplayer: true,
  canControl: true,
  delegatedControlAvailable: true,
  stableSubjectsRequired: false,
};

function hasStatus(status: number): (error: unknown) => boolean {
  return (error) => error instanceof Error && (error as HttpError).status === status;
}

async function mutate(
  action: InteractiveSessionMetadataAction,
  options: {
    session?: InteractiveSession;
    policy?: Partial<InteractiveSessionMetadataPolicy>;
    persist?: boolean;
  } = {},
) {
  const context = fixture({ session: options.session, persist: options.persist });
  const result = await context.service.mutate({
    session: context.session,
    action,
    actor: "operator",
    subject: "github:operator",
    policy: { ...allowedPolicy, ...options.policy },
    now: 100,
  });
  return { ...context, result };
}

test("metadata action detection accepts only service-owned actions", () => {
  for (const action of [
    "share_link",
    "disable_share",
    "enable_multiplayer",
    "disable_multiplayer",
    "request_control",
    "approve_control",
    "deny_control",
    "revoke_control",
  ]) {
    assert.equal(isInteractiveSessionMetadataAction(action), true);
  }
  assert.equal(isInteractiveSessionMetadataAction("attach"), false);
  assert.equal(isInteractiveSessionMetadataAction("stop"), false);
});

test("share link rotates the credential and records durable evidence", async () => {
  const { archives, audits, mutations, result } = await mutate("share_link");

  assert.equal(result.shareToken, "12345678share-token");
  assert.deepEqual(mutations, [
    {
      actor: "operator",
      message: "read-only share link enabled",
      values: {
        share_mode: "link_read",
        share_token_hash: "hash:12345678share-token",
        share_token_preview: "12345678",
      },
      now: 100,
    },
  ]);
  assert.deepEqual(archives, ["IS-7"]);
  assert.deepEqual(audits, ["interactive session share enabled IS-7"]);
});

test("disabling sharing clears share and delegated-control state", async () => {
  const { mutations } = await mutate("disable_share");

  assert.deepEqual(mutations[0]?.values, {
    share_mode: "private",
    share_token_hash: null,
    share_token_preview: null,
    control_requested_by: null,
    control_requested_by_subject: null,
    control_requested_at: null,
    controller: null,
    controller_subject: null,
    control_granted_at: null,
    control_expires_at: null,
  });
});

test("multiplayer changes require the creator policy", async () => {
  await assert.rejects(
    () => mutate("enable_multiplayer", { policy: { canChangeMultiplayer: false } }),
    hasStatus(403),
  );
  const { mutations, audits } = await mutate("disable_multiplayer");
  assert.deepEqual(mutations[0]?.values, { multiplayer_mode: 0 });
  assert.deepEqual(audits, ["interactive session multiplayer disabled IS-7"]);
});

test("control requests require a live revocable session", async () => {
  await assert.rejects(
    () => mutate("request_control", { policy: { delegatedControlAvailable: false } }),
    hasStatus(400),
  );
  const stopped = interactiveSession(sessionRow({ status: "stopped" }), []);
  await assert.rejects(
    () => mutate("request_control", { session: stopped, policy: { canControl: false } }),
    hasStatus(400),
  );
  const stopping = interactiveSession(sessionRow({ status: "stopping" }), []);
  await assert.rejects(
    () => mutate("request_control", { session: stopping, policy: { canControl: false } }),
    hasStatus(400),
  );
  const { mutations } = await mutate("request_control", { policy: { canControl: false } });
  assert.deepEqual(mutations[0]?.values, {
    control_requested_by: "operator",
    control_requested_by_subject: "github:operator",
    control_requested_at: 100,
  });
});

test("existing controllers do not create duplicate requests", async () => {
  const { mutations, result, session } = await mutate("request_control");
  assert.equal(result.session, session);
  assert.deepEqual(mutations, []);
});

test("control approval grants a bounded lease and clears the request", async () => {
  const session = interactiveSession(
    sessionRow({
      id: "IS-7",
      control_requested_by: "reviewer",
      control_requested_by_subject: "github:reviewer",
      control_requested_at: 90,
    }),
    [],
  );
  const { audits, mutations } = await mutate("approve_control", { session });

  assert.deepEqual(mutations[0]?.values, {
    controller: "reviewer",
    controller_subject: "github:reviewer",
    control_granted_at: 100,
    control_expires_at: 1_800_100,
    control_requested_by: null,
    control_requested_by_subject: null,
    control_requested_at: null,
  });
  assert.deepEqual(audits, ["interactive session control granted IS-7 to reviewer"]);
});

test("private control approval rejects a legacy request without a stable subject", async () => {
  const session = interactiveSession(
    sessionRow({ control_requested_by: "ambiguous", control_requested_at: 90 }),
    [],
  );
  await assert.rejects(
    () => mutate("approve_control", { session, policy: { stableSubjectsRequired: true } }),
    { message: "control request has no stable subject" },
  );
});

test("deny and revoke clear only their owned control state", async () => {
  const requested = interactiveSession(
    sessionRow({ control_requested_by: "reviewer", control_requested_at: 90 }),
    [],
  );
  const denied = await mutate("deny_control", { session: requested });
  assert.deepEqual(denied.mutations[0]?.values, {
    control_requested_by: null,
    control_requested_by_subject: null,
    control_requested_at: null,
  });

  const revoked = await mutate("revoke_control");
  assert.deepEqual(revoked.mutations[0]?.values, {
    controller: null,
    controller_subject: null,
    control_granted_at: null,
    control_expires_at: null,
  });
});

test("lost metadata ownership reports a conflict before audit or reread", async () => {
  const context = fixture({ persist: false });
  await assert.rejects(
    () =>
      context.service.mutate({
        session: context.session,
        action: "disable_share",
        actor: "operator",
        subject: "github:operator",
        policy: allowedPolicy,
        now: 100,
      }),
    hasStatus(409),
  );
  assert.deepEqual(context.archives, []);
  assert.deepEqual(context.audits, []);
});

test("archive refresh failures do not roll back persisted metadata", async () => {
  const context = fixture({ archiveFailure: true });
  const result = await context.service.mutate({
    session: context.session,
    action: "disable_share",
    actor: "operator",
    subject: "github:operator",
    policy: allowedPolicy,
    now: 100,
  });

  assert.equal(result.session, context.session);
  assert.deepEqual(context.archives, ["IS-7"]);
  assert.deepEqual(context.audits, ["interactive session share disabled IS-7"]);
});

test("summary updates normalize fields and refresh archives before rereading", async () => {
  const context = fixture();
  const result = await context.service.updateSummary({
    sessionId: "IS-7",
    actor: "operator",
    purpose: ` ${"p".repeat(600)} `,
    summary: " done ",
    now: 100,
    canManage: () => true,
  });

  assert.equal(result, context.session);
  assert.deepEqual(context.mutations, [
    {
      actor: "operator",
      message: "session summary updated",
      values: {
        purpose: "p".repeat(500),
        summary: "done",
      },
      now: 100,
    },
  ]);
  assert.deepEqual(context.archives, ["IS-7"]);
});

test("purpose-only updates retain distinct evidence", async () => {
  const context = fixture();
  await context.service.updateSummary({
    sessionId: "IS-7",
    actor: "operator",
    purpose: " investigate ",
    now: 100,
    canManage: () => true,
  });

  assert.equal(context.mutations[0]?.message, "session purpose updated");
  assert.deepEqual(context.mutations[0]?.values, { purpose: "investigate" });
});

test("summary updates reject missing, unauthorized, and stale sessions", async () => {
  const missing = fixture({ readSession: null });
  await assert.rejects(
    missing.service.updateSummary({
      sessionId: "IS-missing",
      actor: "operator",
      summary: "missing",
      now: 100,
      canManage: () => true,
    }),
    hasStatus(404),
  );

  const blank = fixture();
  await assert.rejects(
    blank.service.updateSummary({
      sessionId: "IS-7",
      actor: "operator",
      purpose: " ",
      summary: "",
      now: 100,
      canManage: () => true,
    }),
    hasStatus(400),
  );
  assert.deepEqual(blank.mutations, []);

  const unauthorized = fixture();
  await assert.rejects(
    unauthorized.service.updateSummary({
      sessionId: "IS-7",
      actor: "operator",
      summary: "hidden",
      now: 100,
      canManage: () => false,
    }),
    hasStatus(403),
  );
  assert.deepEqual(unauthorized.mutations, []);

  const stale = fixture({ persist: false });
  await assert.rejects(
    stale.service.updateSummary({
      sessionId: "IS-7",
      actor: "operator",
      summary: "raced",
      now: 100,
      canManage: () => true,
    }),
    hasStatus(409),
  );
  assert.deepEqual(stale.archives, []);
});
