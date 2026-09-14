import assert from "node:assert/strict";
import test from "node:test";

import { handlePublicAuthRoute } from "../src/worker/routes/auth.ts";

test("native-link path rejects malformed percent encoding", async () => {
  let called = false;
  await assert.rejects(
    () =>
      handlePublicAuthRoute(
        new Request("https://fleet.example/native/link/%"),
        new URL("https://fleet.example/native/link/%"),
        { kind: "disabled" },
        {
          githubLogin: async () => new Response(),
          githubCallback: async () => new Response(),
          nativeLink: async () => {
            called = true;
            return new Response();
          },
          tokenLogin: async () => new Response(),
          devIdentityLogin: async () => new Response(),
          logout: async () => new Response(),
          authState: () => new Response(),
        },
      ),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 400);
      return true;
    },
  );
  assert.equal(called, false);
});
