import assert from "node:assert/strict";
import test from "node:test";

import {
  isSandboxSessionAlreadyExists,
  isSandboxSessionAlreadyGone,
} from "../src/worker/sandbox-session-errors.ts";

test("Sandbox session existence errors require a matching session context when provided", () => {
  assert.equal(
    isSandboxSessionAlreadyExists({ code: "SESSION_ALREADY_EXISTS" }, "terminal-1"),
    true,
  );
  assert.equal(
    isSandboxSessionAlreadyExists(
      {
        errorResponse: {
          code: "SESSION_ALREADY_EXISTS",
          context: { sessionId: "terminal-1" },
        },
      },
      "terminal-1",
    ),
    true,
  );
  assert.equal(
    isSandboxSessionAlreadyExists(
      {
        errorResponse: {
          code: "SESSION_ALREADY_EXISTS",
          context: { sessionId: "terminal-2" },
        },
      },
      "terminal-1",
    ),
    false,
  );
  assert.equal(isSandboxSessionAlreadyExists(new Error("already exists"), "terminal-1"), false);
});

test("Sandbox terminal cleanup accepts only exact gone errors", () => {
  for (const code of ["SESSION_DESTROYED", "SESSION_TERMINATED", "FILE_NOT_FOUND"]) {
    assert.equal(
      isSandboxSessionAlreadyGone(
        { errorResponse: { code, context: { sessionId: "terminal-1" } } },
        "terminal-1",
      ),
      true,
    );
  }
  assert.equal(
    isSandboxSessionAlreadyGone(
      {
        errorResponse: {
          code: "SESSION_TERMINATED",
          context: { sessionId: "terminal-2" },
        },
      },
      "terminal-1",
    ),
    false,
  );
  assert.equal(
    isSandboxSessionAlreadyGone(new Error("Session 'terminal-1' not found"), "terminal-1"),
    true,
  );
  assert.equal(
    isSandboxSessionAlreadyGone(new Error('Session "terminal-1" not found'), "terminal-1"),
    true,
  );
  assert.equal(
    isSandboxSessionAlreadyGone(new Error("Session terminal-1 not found"), "terminal-1"),
    false,
  );
  assert.equal(
    isSandboxSessionAlreadyGone(new Error("Session 'terminal-2' not found"), "terminal-1"),
    false,
  );
});
