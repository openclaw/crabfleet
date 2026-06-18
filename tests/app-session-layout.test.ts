import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultSessionLayout,
  loadSessionLayout,
  moveSessionLayoutItem,
  normalizeSessionLayout,
  orderedSessionItems,
  saveSessionLayout,
} from "../src/app/session-layout.js";

test("session layout normalization bounds persisted values", () => {
  assert.deepEqual(
    normalizeSessionLayout({
      columns: 4,
      edit: true,
      manualOrder: 1,
      order: Array.from({ length: 205 }, (_, index) => index),
      sizes: { "IS-1": "large" },
    }),
    {
      columns: "4",
      edit: false,
      manualOrder: true,
      order: Array.from({ length: 200 }, (_, index) => String(index)),
      sizes: { "IS-1": "large" },
    },
  );
  assert.equal(normalizeSessionLayout({ columns: "wide" }).columns, "auto");
});

test("session layout ordering retains new items and supports stable moves", () => {
  const items = [{ id: "IS-1" }, { id: "IS-2" }, { id: "IS-3" }];
  const layout = { ...defaultSessionLayout(), manualOrder: true, order: ["IS-2", "missing"] };

  assert.deepEqual(
    orderedSessionItems(items, layout).map((item) => item.id),
    ["IS-2", "IS-1", "IS-3"],
  );
  assert.deepEqual(moveSessionLayoutItem(layout, items, "IS-3", "IS-2").order, [
    "IS-3",
    "IS-2",
    "IS-1",
  ]);
  assert.equal(moveSessionLayoutItem(layout, items, "missing", "IS-2"), layout);
});

test("session layout persistence stores durable fields and fails closed", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
  const layout = {
    columns: "3",
    edit: true,
    manualOrder: true,
    order: ["IS-2"],
    sizes: { "IS-2": "large" },
  };

  saveSessionLayout(layout, storage);
  assert.deepEqual(loadSessionLayout(storage), { ...layout, edit: false });

  values.set("crabbox-session-layout-v1", "{");
  assert.deepEqual(loadSessionLayout(storage), defaultSessionLayout());
});
