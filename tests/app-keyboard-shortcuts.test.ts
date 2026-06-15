import assert from "node:assert/strict";
import test from "node:test";

import { handleAppEscape } from "../src/app/keyboard-shortcuts.js";

function escapeEvent(overrides = {}) {
  let prevented = false;
  return {
    key: "Escape",
    isComposing: false,
    target: { closest: () => null },
    preventDefault: () => {
      prevented = true;
    },
    wasPrevented: () => prevented,
    ...overrides,
  };
}

test("Escape closes an action dialog before changing drawer navigation", () => {
  const calls: string[] = [];
  const event = escapeEvent();
  const handled = handleAppEscape(event, {
    dialog: { kind: "danger", error: "Failed to fetch" },
    closeActionDialog: () => calls.push("dialog"),
    closeTopDrawer: () => {
      calls.push("drawer");
      return true;
    },
  });

  assert.equal(handled, true);
  assert.equal(event.wasPrevented(), true);
  assert.deepEqual(calls, ["dialog"]);
});

test("Escape closes a drawer only when no action dialog owns the key", () => {
  const calls: string[] = [];
  const event = escapeEvent();
  const handled = handleAppEscape(event, {
    dialog: null,
    closeActionDialog: () => calls.push("dialog"),
    closeTopDrawer: () => {
      calls.push("drawer");
      return true;
    },
  });

  assert.equal(handled, true);
  assert.equal(event.wasPrevented(), true);
  assert.deepEqual(calls, ["drawer"]);
});

test("Escape ignores terminal input and composition", () => {
  for (const event of [
    escapeEvent({ isComposing: true }),
    escapeEvent({ target: { closest: () => ({}) } }),
  ]) {
    const handled = handleAppEscape(event, {
      dialog: { kind: "danger" },
      closeActionDialog: () => assert.fail("dialog should stay open"),
      closeTopDrawer: () => assert.fail("drawer should stay open"),
    });
    assert.equal(handled, false);
    assert.equal(event.wasPrevented(), false);
  }
});
