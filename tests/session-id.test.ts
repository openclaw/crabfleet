import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { allocateInteractiveSessionIdSql, formatInteractiveSessionId } from "../src/session-id.ts";

test("interactive session ids remain monotonic after cleanup", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(
    `CREATE TABLE interactive_sessions (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT,
      root_session_id TEXT,
      repo TEXT NOT NULL DEFAULT 'example/project',
      branch TEXT NOT NULL DEFAULT 'main',
      runtime TEXT NOT NULL DEFAULT 'container',
      adapter TEXT,
      profile TEXT NOT NULL DEFAULT 'default',
      adapter_workspace_id TEXT,
      adapter_control_plane TEXT,
      provider_resource_id TEXT,
      terminal_status TEXT,
      lease_id TEXT,
      attach_url TEXT,
      vnc_url TEXT,
      command TEXT NOT NULL DEFAULT 'codex --yolo',
      prompt TEXT NOT NULL DEFAULT '',
      purpose TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL DEFAULT 'operator',
      created_by TEXT NOT NULL DEFAULT 'operator',
      status TEXT NOT NULL DEFAULT 'ready',
      updated_at INTEGER NOT NULL DEFAULT 1,
      stopped_at INTEGER,
      agent_token_hash TEXT,
      control_requested_by TEXT,
      control_requested_at INTEGER,
      controller TEXT,
      control_granted_at INTEGER,
      control_expires_at INTEGER,
      reconcile_error TEXT,
      last_event TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE interactive_session_log_archives (
      session_id TEXT PRIMARY KEY,
      event_count INTEGER NOT NULL DEFAULT 0,
      events_key TEXT,
      transcript_key TEXT,
      summary_key TEXT,
      archived_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
  database.exec("INSERT INTO interactive_sessions(id) VALUES ('IS-101'), ('IS-109')");
  database.exec(
    "INSERT INTO interactive_sessions(id, runtime, adapter, status, adapter_workspace_id, lease_id, reconcile_error) VALUES ('IS-108', 'crabbox', 'runtime-v1', 'failed', 'fleet-is-108', 'sandbox:provider-owned', 'provider create failed: quota')",
  );
  database.exec(
    "INSERT INTO interactive_sessions(id, runtime, adapter, status, adapter_workspace_id) VALUES ('IS-107', 'crabbox', 'runtime-v1', 'stopped', 'fleet-is-107')",
  );
  database.exec(
    "INSERT INTO interactive_sessions(id, runtime, status, lease_id, attach_url, vnc_url, agent_token_hash, control_requested_by, control_requested_at, controller, control_granted_at, control_expires_at) VALUES ('IS-106', 'container', 'expired', 'sandbox:legacy', 'wss://terminal', 'https://desktop', 'agent-hash', 'requester', 2, 'controller', 3, 4)",
  );
  database.exec(
    "INSERT INTO interactive_sessions(id, runtime, status, lease_id, agent_token_hash) VALUES ('IS-105', 'container', 'ready', 'sandbox:active:terminal', 'active-agent-hash')",
  );
  database.exec(
    "INSERT INTO interactive_sessions(id, runtime, status) VALUES ('IS-104', 'container', 'failed')",
  );
  database.exec(
    "INSERT INTO interactive_sessions(id, runtime, status, lease_id, reconcile_error, last_event) VALUES ('IS-103', 'container', 'failed', 'sandbox:failed', 'sandbox terminal failed: shell exited', 'generic cleanup pending')",
  );
  database.exec(
    readFileSync(
      new URL("../migrations/0021_runtime_adapter_hardening.sql", import.meta.url),
      "utf8",
    ),
  );

  const allocate = database.prepare(allocateInteractiveSessionIdSql);
  assert.equal(formatInteractiveSessionId(Number(allocate.get()?.next_id)), "IS-110");
  database.exec("DELETE FROM interactive_sessions WHERE id = 'IS-109'");
  assert.equal(formatInteractiveSessionId(Number(allocate.get()?.next_id)), "IS-111");
  const migrated = database
    .prepare(
      "SELECT status, terminal_status, terminal_failure_reason, adapter_create_pending, terminal_finalize_pending, adapter_ttl_seconds, adapter_idle_timeout_seconds, adapter_requested_capabilities_json, adapter_create_payload_json, adapter_control_plane, provider_resource_id, lease_id FROM interactive_sessions WHERE id = 'IS-108'",
    )
    .get();
  assert.equal(migrated?.status, "stopping");
  assert.equal(migrated?.terminal_status, "failed");
  assert.equal(migrated?.terminal_failure_reason, "provider create failed: quota");
  assert.equal(migrated?.adapter_create_pending, 0);
  assert.equal(migrated?.terminal_finalize_pending, 0);
  assert.equal(migrated?.adapter_ttl_seconds, 14_400);
  assert.equal(migrated?.adapter_idle_timeout_seconds, 1_800);
  assert.equal(migrated?.adapter_control_plane, null);
  assert.equal(migrated?.provider_resource_id, "sandbox:provider-owned");
  assert.equal(migrated?.lease_id, null);
  assert.equal(JSON.parse(String(migrated?.adapter_requested_capabilities_json)).desktop, true);
  const createPayload = JSON.parse(String(migrated?.adapter_create_payload_json));
  assert.equal(createPayload.id, "fleet-is-108");
  assert.equal(createPayload.capabilities.desktop, true);
  const terminal = database
    .prepare("SELECT terminal_finalize_pending FROM interactive_sessions WHERE id = 'IS-107'")
    .get();
  assert.equal(terminal?.terminal_finalize_pending, 1);
  const legacyTerminal = database
    .prepare("SELECT terminal_finalize_pending FROM interactive_sessions WHERE id = 'IS-106'")
    .get();
  assert.equal(legacyTerminal?.terminal_finalize_pending, 1);
  const legacyFailure = database
    .prepare("SELECT terminal_finalize_pending FROM interactive_sessions WHERE id = 'IS-104'")
    .get();
  assert.equal(legacyFailure?.terminal_finalize_pending, 1);

  database.exec(
    readFileSync(
      new URL("../migrations/0022_credential_policy_cleanup.sql", import.meta.url),
      "utf8",
    ),
  );
  const terminalPolicy = database
    .prepare(
      "SELECT state, sandbox_id, lookup_id, registration_generation, registration_claim, registration_claim_expires_at FROM interactive_session_credential_policies WHERE session_id = 'IS-106'",
    )
    .get();
  assert.deepEqual(
    { ...terminalPolicy },
    {
      state: "cleanup_pending",
      sandbox_id: "legacy",
      lookup_id: "legacy",
      registration_generation: "legacy:IS-106:legacy",
      registration_claim: null,
      registration_claim_expires_at: null,
    },
  );
  const failedSandbox = database
    .prepare(
      "SELECT terminal_failure_reason, credential_cleanup_terminal_status FROM interactive_sessions WHERE id = 'IS-103'",
    )
    .get();
  assert.deepEqual(
    { ...failedSandbox },
    {
      terminal_failure_reason: "sandbox terminal failed: shell exited",
      credential_cleanup_terminal_status: "failed",
    },
  );
  assert.deepEqual(
    {
      ...database
        .prepare(
          "SELECT last_rowid, scan_max_rowid, group_session_id, group_sandbox_id, group_max_session_id, group_max_sandbox_id FROM credential_policy_reconcile_state WHERE id = 1",
        )
        .get(),
    },
    {
      last_rowid: 0,
      scan_max_rowid: 0,
      group_session_id: "",
      group_sandbox_id: "",
      group_max_session_id: "",
      group_max_sandbox_id: "",
    },
  );
  const migratedTerminalPolicy = database
    .prepare(
      "SELECT status, credential_cleanup_terminal_status, terminal_finalize_pending, agent_token_hash, attach_url, vnc_url, control_requested_by, control_requested_at, controller, control_granted_at, control_expires_at FROM interactive_sessions WHERE id = 'IS-106'",
    )
    .get();
  assert.deepEqual(
    { ...migratedTerminalPolicy },
    {
      status: "stopping",
      credential_cleanup_terminal_status: "expired",
      terminal_finalize_pending: 0,
      agent_token_hash: null,
      attach_url: null,
      vnc_url: null,
      control_requested_by: null,
      control_requested_at: null,
      controller: null,
      control_granted_at: null,
      control_expires_at: null,
    },
  );
  const activePolicy = database
    .prepare(
      "SELECT state, sandbox_id, lookup_id, registration_generation, registration_claim, registration_claim_expires_at FROM interactive_session_credential_policies WHERE session_id = 'IS-105'",
    )
    .get();
  assert.deepEqual(
    { ...activePolicy },
    {
      state: "active",
      sandbox_id: "active",
      lookup_id: "active",
      registration_generation: "legacy:IS-105:active",
      registration_claim: null,
      registration_claim_expires_at: null,
    },
  );
  const migratedActivePolicy = database
    .prepare(
      "SELECT credential_cleanup_terminal_status, agent_token_hash FROM interactive_sessions WHERE id = 'IS-105'",
    )
    .get();
  assert.deepEqual(
    { ...migratedActivePolicy },
    {
      credential_cleanup_terminal_status: null,
      agent_token_hash: "active-agent-hash",
    },
  );
  assert.equal(
    database
      .prepare("SELECT terminal_finalize_pending FROM interactive_sessions WHERE id = 'IS-107'")
      .get()?.terminal_finalize_pending,
    1,
  );
  const refreshFence = database
    .prepare(
      "SELECT sandbox_refresh_sandbox_id, sandbox_refresh_claim, sandbox_refresh_claim_expires_at FROM interactive_sessions WHERE id = 'IS-105'",
    )
    .get();
  assert.deepEqual(
    { ...refreshFence },
    {
      sandbox_refresh_sandbox_id: null,
      sandbox_refresh_claim: null,
      sandbox_refresh_claim_expires_at: null,
    },
  );
  const standaloneColumns = database
    .prepare("PRAGMA table_info(standalone_sandbox_provisions)")
    .all()
    .map((column) => column.name);
  assert.ok(standaloneColumns.includes("request_hash"));
  assert.ok(standaloneColumns.includes("ownership_claim"));
  assert.ok(standaloneColumns.includes("lease_id"));
  database.exec(`
    INSERT INTO standalone_sandbox_provisions (
      id, request_hash, sandbox_id, state, message, created_at, updated_at
    ) VALUES
      ('IS-42', 'managed-hash', 'managed-sandbox', 'active', 'legacy reserved id', 1000, 1000),
      ('iS-142', 'mixed-case-hash', 'mixed-case-sandbox', 'active', 'legacy mixed-case reserved id', 1500, 1500),
      ('is-1worker', 'worker-hash', 'worker-sandbox', 'active', 'ordinary id', 2000, 2000)
  `);
  database.exec(
    readFileSync(
      new URL("../migrations/0023_standalone_sandbox_expiry.sql", import.meta.url),
      "utf8",
    ),
  );
  const standaloneExpiries = database
    .prepare(
      "SELECT id, expires_at FROM standalone_sandbox_provisions ORDER BY id COLLATE NOCASE ASC",
    )
    .all();
  assert.deepEqual(
    standaloneExpiries.map((row) => ({ ...row })),
    [
      { id: "iS-142", expires_at: 0 },
      { id: "is-1worker", expires_at: 14_402_000 },
      { id: "IS-42", expires_at: 0 },
    ],
  );
  assert.equal(formatInteractiveSessionId(Number(allocate.get()?.next_id)), "IS-143");
});
