import assert from "node:assert/strict";
import test from "node:test";

import { annexBToAvcc, avcDescription, parseAnnexB } from "../src/app/rfb/h264.ts";

test("Annex-B parser accepts three- and four-byte start codes", () => {
  const payload = new Uint8Array([
    0, 0, 0, 1, 0x67, 0x42, 0, 0x1f, 0xaa, 0, 0, 1, 0x68, 0xbb, 0, 0, 0, 1, 0x65, 1, 2, 3,
  ]);
  const units = parseAnnexB(payload);
  assert.deepEqual(
    units.map((unit) => unit.type),
    [7, 8, 5],
  );
  assert.deepEqual(
    [...annexBToAvcc(units)],
    [0, 0, 0, 5, 0x67, 0x42, 0, 0x1f, 0xaa, 0, 0, 0, 2, 0x68, 0xbb, 0, 0, 0, 4, 0x65, 1, 2, 3],
  );
});

test("AVC description carries SPS and PPS with four-byte NAL lengths", () => {
  const sps = new Uint8Array([0x67, 0x42, 0x80, 0x1f, 0xaa]);
  const pps = new Uint8Array([0x68, 0xbb]);
  assert.deepEqual(
    [...avcDescription(sps, pps)],
    [1, 0x42, 0x80, 0x1f, 0xff, 0xe1, 0, 5, ...sps, 1, 0, 2, ...pps],
  );
});

test("Annex-B parser rejects pathological NAL counts", () => {
  const payload = new Uint8Array(4 * 1_026);
  for (let offset = 0; offset < payload.byteLength; offset += 4) {
    payload.set([0, 0, 1, 0x09], offset);
  }
  assert.throws(() => parseAnnexB(payload), /too many NAL units/);
});
