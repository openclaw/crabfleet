import assert from "node:assert/strict";
import test from "node:test";

import { CanvasRenderer } from "../src/app/rfb/render.ts";

test("canvas presentation rejects instead of stalling when 2D rendering is unavailable", async () => {
  let callback: (() => void) | null = null;
  Object.assign(globalThis, {
    requestAnimationFrame: (next: () => void) => {
      callback = next;
      return 1;
    },
    window: { devicePixelRatio: 1 },
  });
  let closed = false;
  const renderer = new CanvasRenderer({
    width: 0,
    height: 0,
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
    getContext: () => null,
  });
  const presented = renderer.present({
    width: 800,
    height: 600,
    close: () => {
      closed = true;
    },
  });
  assert.ok(callback);
  callback();
  await assert.rejects(presented, /2D canvas rendering is unavailable/);
  assert.equal(closed, true);
});
