import assert from "node:assert/strict";
import test from "node:test";

import { createOpenClawEmbedTicket } from "../src/openclaw-service.ts";
import {
  canControlOpenClawEmbeddedTerminalRequest,
  isOpenClawEmbedSessionToken,
} from "../src/worker/openclaw-embed-access.ts";

test("embedded terminal requests require an exact session-scoped ticket", async () => {
  const now = 1_800_000_000_000;
  const env = { CRABBOX_EMBED_TICKET_SECRET: "embed-secret" };
  const token = await createOpenClawEmbedTicket("embed-secret", "IS-2", now + 60_000);
  const request = new Request(
    `https://fleet.example/api/terminal/ws?shareSession=IS-2&token=${encodeURIComponent(token)}`,
  );

  assert.equal(await isOpenClawEmbedSessionToken(env, "IS-2", token, now), true);
  assert.equal(await canControlOpenClawEmbeddedTerminalRequest(request, env, "IS-2", now), true);
  assert.equal(await canControlOpenClawEmbeddedTerminalRequest(request, env, "IS-3", now), false);
  assert.equal(
    await canControlOpenClawEmbeddedTerminalRequest(
      new Request(
        `https://fleet.example/api/terminal/ws?shareSession=IS-3&token=${encodeURIComponent(token)}`,
      ),
      env,
      "IS-2",
      now,
    ),
    false,
  );
  assert.equal(
    await canControlOpenClawEmbeddedTerminalRequest(request, env, "IS-2", now + 60_000),
    false,
  );
  assert.equal(await isOpenClawEmbedSessionToken({}, "IS-2", token, now), false);
});
