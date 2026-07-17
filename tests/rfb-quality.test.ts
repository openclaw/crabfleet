import assert from "node:assert/strict";
import test from "node:test";

import { loadViewerQuality, qualityStorageKey, saveViewerQuality } from "../src/app/rfb/quality.ts";

test("browser quality preference persists per host for the tab session", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };

  assert.equal(loadViewerQuality(storage, "host-1"), "auto");
  saveViewerQuality(storage, "host-1", "sharp");
  saveViewerQuality(storage, "host-2", "smooth");
  assert.equal(loadViewerQuality(storage, "host-1"), "sharp");
  assert.equal(loadViewerQuality(storage, "host-2"), "smooth");
  assert.equal(qualityStorageKey("host-1"), "crabfleet.desktop.quality.host-1");

  values.set(qualityStorageKey("host-1"), "invalid");
  assert.equal(loadViewerQuality(storage, "host-1"), "auto");
});
