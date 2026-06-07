import assert from "node:assert/strict";
import { test } from "node:test";
import { githubOAuthRedirectUri } from "../src/oauth.ts";

test("githubOAuthRedirectUri uses configured callback when present", () => {
  assert.equal(
    githubOAuthRedirectUri(
      "https://clawfleet.openclaw.ai/login/github",
      " https://crabfleet.ai/auth/github/callback ",
    ),
    "https://crabfleet.ai/auth/github/callback",
  );
});

test("githubOAuthRedirectUri defaults to request origin callback", () => {
  assert.equal(
    githubOAuthRedirectUri("https://clawfleet.openclaw.ai/login/github"),
    "https://clawfleet.openclaw.ai/auth/github/callback",
  );
});
