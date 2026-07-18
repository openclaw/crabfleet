import assert from "node:assert/strict";
import test from "node:test";

import { vncChallengeResponse } from "../src/app/rfb/vnc-auth.ts";

test("browser VNC DES matches the RoyalVNCKit compatibility vector", () => {
  const challenge = new Uint8Array(Array.from({ length: 16 }, (_, index) => index));
  assert.deepEqual(
    vncChallengeResponse(challenge, "test-auth-token"),
    Uint8Array.from([
      0x8a, 0x5f, 0xa9, 0x58, 0xf0, 0xd8, 0x19, 0xbd, 0xcb, 0x98, 0x1c, 0x9b, 0x47, 0x63, 0x6e,
      0xd0,
    ]),
  );
});

test("browser VNC DES enforces challenge and ISO-8859-1 bounds", () => {
  assert.throws(() => vncChallengeResponse(new Uint8Array(15), "test-auth-token"), /16 bytes/);
  assert.throws(() => vncChallengeResponse(new Uint8Array(16), "snowman-☃"), /ISO-8859-1/);
  assert.deepEqual(
    vncChallengeResponse(new Uint8Array(16), "12345678ignored"),
    vncChallengeResponse(new Uint8Array(16), "12345678"),
  );
});
