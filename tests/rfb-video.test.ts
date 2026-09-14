import assert from "node:assert/strict";
import test from "node:test";

import { supportsWebCodecsH264 } from "../src/app/rfb/h264.ts";
import { supportsWebCodecsHEVC, supportsWebCodecsHEVCRExt } from "../src/app/rfb/hevc.ts";

test("video support probes preserve codec profiles and fall back on missing or rejected support", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "VideoDecoder");
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "VideoDecoder", previous);
    else Reflect.deleteProperty(globalThis, "VideoDecoder");
  });
  const probes = [
    [supportsWebCodecsH264, "avc1.42E01F"],
    [supportsWebCodecsHEVC, "hvc1.1.6.L120.90"],
    [supportsWebCodecsHEVCRExt, "hvc1.4.10.L120.9c"],
  ] as const;
  for (const [probe, codec] of probes) {
    Object.defineProperty(globalThis, "VideoDecoder", { configurable: true, value: undefined });
    assert.equal(await probe(), false);
    for (const response of [
      { supported: true },
      { supported: false },
      {},
      new Error("unsupported"),
    ]) {
      Object.defineProperty(globalThis, "VideoDecoder", {
        configurable: true,
        value: {
          async isConfigSupported(config: unknown) {
            assert.deepEqual(config, { codec, optimizeForLatency: true });
            if (response instanceof Error) throw response;
            return response;
          },
        },
      });
      assert.equal(await probe(), "supported" in response && response.supported === true);
    }
  }
});
