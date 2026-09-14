import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { CanvasRenderer } from "../src/app/rfb/render.ts";

test("canvas presentation rejects instead of stalling when 2D rendering is unavailable", async (t) => {
  const fixture = rendererFixture(t);
  fixture.canvas.getContext = () => null;
  const frame = trackedFrame();
  const presented = fixture.renderer.present(frame);
  fixture.draw();
  await assert.rejects(presented, /2D canvas rendering is unavailable/);
  assert.equal(frame.closed, 1);
});

test("canvas drawing errors release the frame, reject presentation, and allow recovery", async (t) => {
  const fixture = rendererFixture(t);
  const failure = new Error("canvas drawing failed");
  fixture.context.drawImage = () => {
    throw failure;
  };
  const failed = trackedFrame();
  const presented = fixture.renderer.present(failed);
  assert.doesNotThrow(() => fixture.draw());
  await assert.rejects(presented, (error) => error === failure);
  assert.equal(failed.closed, 1);

  const recovered = trackedFrame();
  fixture.context.drawImage = () => {};
  const next = fixture.renderer.present(recovered);
  fixture.draw();
  await next;
  assert.equal(recovered.closed, 1);
});

test("canvas replacement and clear settle only the discarded frames", async (t) => {
  const fixture = rendererFixture(t);
  const first = trackedFrame();
  const second = trackedFrame();
  const third = trackedFrame();
  const discarded = fixture.renderer.present(first);
  const cleared = fixture.renderer.present(second);
  await discarded;
  assert.equal(first.closed, 1);
  assert.equal(second.closed, 0);
  fixture.renderer.clear();
  await cleared;
  assert.equal(second.closed, 1);

  const presented = fixture.renderer.present(third);
  fixture.draw();
  await presented;
  assert.equal(third.closed, 1);
  assert.deepEqual(fixture.drawn, [third]);
});

function trackedFrame() {
  return {
    width: 800,
    height: 600,
    closed: 0,
    close() {
      this.closed += 1;
    },
  };
}

function rendererFixture(t: TestContext) {
  const descriptors = ["requestAnimationFrame", "window"].map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  t.after(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  let callback: (() => void) | null = null;
  Object.assign(globalThis, {
    requestAnimationFrame: (next: () => void) => {
      assert.equal(callback, null, "only one animation callback may be scheduled");
      callback = next;
      return 1;
    },
    window: { devicePixelRatio: 1 },
  });
  const drawn: unknown[] = [];
  const context = {
    fillStyle: "",
    clearRect() {},
    fillRect() {},
    drawImage(frame: unknown) {
      drawn.push(frame);
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
    getContext: (): typeof context | null => context,
  };
  return {
    renderer: new CanvasRenderer(canvas),
    canvas,
    context,
    drawn,
    draw() {
      assert.ok(callback);
      const next = callback;
      callback = null;
      next();
    },
  };
}
