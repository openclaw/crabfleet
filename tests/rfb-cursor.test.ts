import assert from "node:assert/strict";
import test from "node:test";

import {
  cursorCSS,
  remotePointerAfterCursorShape,
  shouldShowCursorOverlay,
} from "../src/app/rfb/cursor.ts";

test("cursor CSS preserves image and hotspot within the 128px cap", () => {
  assert.equal(
    cursorCSS("data:image/png;base64,dGVzdA==", 3, 4, 16, 20),
    'url("data:image/png;base64,dGVzdA==") 3 4, default',
  );
  assert.throws(
    () => cursorCSS("data:image/png;base64,dGVzdA==", 0, 0, 129, 1),
    /invalid browser cursor/,
  );
  assert.throws(
    () => cursorCSS("data:image/png;base64,dGVzdA==", 16, 0, 16, 16),
    /invalid browser cursor/,
  );
});

test("remote cursor overlay follows focus and local convergence", () => {
  const remote = { x: 10, y: 20 };
  assert.equal(shouldShowCursorOverlay(null, null, false), false);
  assert.equal(shouldShowCursorOverlay(remote, null, true), true);
  assert.equal(shouldShowCursorOverlay(remote, { x: 10, y: 20 }, true), false);
  assert.equal(shouldShowCursorOverlay(remote, { x: 11, y: 20 }, true), true);
  assert.equal(shouldShowCursorOverlay(remote, { x: 10, y: 20 }, false), true);
  assert.deepEqual(remotePointerAfterCursorShape(remote, true), remote);
  assert.equal(remotePointerAfterCursorShape(remote, false), null);
});
