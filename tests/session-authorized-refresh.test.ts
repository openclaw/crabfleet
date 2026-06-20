import assert from "node:assert/strict";
import test from "node:test";

import { readAuthorizedFreshSession } from "../src/worker/session-authorized-refresh.ts";

test("targeted refresh authorizes before work and revalidates afterward", async () => {
  const hiddenCalls: string[] = [];
  assert.equal(
    await readAuthorizedFreshSession({
      async read() {
        hiddenCalls.push("read");
        return { visible: false };
      },
      async authorize(session) {
        hiddenCalls.push(`authorize:${session.visible}`);
        return session.visible;
      },
      async refresh() {
        hiddenCalls.push("refresh");
      },
    }),
    null,
  );
  assert.deepEqual(hiddenCalls, ["read", "authorize:false"]);

  const visibleCalls: string[] = [];
  let reads = 0;
  assert.equal(
    await readAuthorizedFreshSession({
      async read() {
        reads += 1;
        visibleCalls.push(`read:${reads}`);
        return { visible: reads === 1 };
      },
      async authorize(session) {
        visibleCalls.push(`authorize:${session.visible}`);
        return session.visible;
      },
      async refresh() {
        visibleCalls.push("refresh");
      },
    }),
    null,
  );
  assert.deepEqual(visibleCalls, [
    "read:1",
    "authorize:true",
    "refresh",
    "read:2",
    "authorize:false",
  ]);
});
