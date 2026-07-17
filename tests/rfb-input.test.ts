import assert from "node:assert/strict";
import test from "node:test";

import { keysymForKey, pointerButtonMask, scrollButtonMask } from "../src/app/rfb/input.ts";

test("keyboard mapping covers text, navigation, modifiers, and function keys", () => {
  assert.equal(keysymForKey("A"), 0x41);
  assert.equal(keysymForKey("é"), 0xe9);
  assert.equal(keysymForKey("🦀"), 0x0101f980);
  assert.equal(keysymForKey("ArrowLeft"), 0xff51);
  assert.equal(keysymForKey("Control"), 0xffe3);
  assert.equal(keysymForKey("Enter"), 0xff0d);
  assert.equal(keysymForKey("Delete"), 0xffff);
  assert.equal(keysymForKey("F12"), 0xffc9);
  assert.equal(keysymForKey("Unidentified"), null);
});

test("pointer and scroll button masks match RFB bit assignments", () => {
  assert.equal(pointerButtonMask(1 | 2 | 4), 0x07);
  assert.equal(scrollButtonMask(0, -1), 0x08);
  assert.equal(scrollButtonMask(0, 1), 0x10);
  assert.equal(scrollButtonMask(-1, 0), 0x20);
  assert.equal(scrollButtonMask(1, 0), 0x40);
  assert.equal(scrollButtonMask(0, 0), 0);
});
