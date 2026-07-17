import assert from "node:assert/strict";
import test from "node:test";

import { ViewerStatsWindow } from "../src/app/rfb/stats.ts";

test("viewer stats computes decoded fps and incoming Mbit/s over one second", () => {
  const stats = new ViewerStatsWindow(0);
  stats.recordDecodedFrame(100);
  stats.recordDecodedFrame(900);
  stats.recordTraffic(125_000, 100);
  assert.deepEqual(stats.snapshot(1_000), { fps: 2, mbitPerSecond: 1 });
});

test("viewer stats prunes samples outside the rolling window", () => {
  const stats = new ViewerStatsWindow(0);
  stats.recordDecodedFrame(500);
  stats.recordTraffic(250_000, 500);
  stats.recordDecodedFrame(1_500);
  stats.recordTraffic(125_000, 1_500);
  assert.deepEqual(stats.snapshot(1_501), { fps: 1, mbitPerSecond: 1 });
});
