import assert from "node:assert/strict";
import { test } from "node:test";
import { sandboxGitAuthorEmail } from "../src/git-identity.ts";

test("sandbox Git authors preserve asserted email identities", () => {
  assert.equal(sandboxGitAuthorEmail("Owner@Example.com"), "owner@example.com");
});

test("sandbox Git authors derive safe noreply addresses for logins", () => {
  assert.equal(sandboxGitAuthorEmail("@octo/cat"), "octo-cat@users.noreply.github.com");
  assert.equal(sandboxGitAuthorEmail(""), "crabfleet@users.noreply.github.com");
});
