import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeFileGetRequest,
  encodeFileListRequest,
  encodeFileMkdirRequest,
  encodeFilePutBeginRequest,
  encodeFilePutAbortRequest,
  encodeFilePutChunkRequest,
  encodeFilePutEndRequest,
  maximumFileSharingChunkBytes,
  readFileSharingMessage,
} from "../src/app/rfb/file-sharing.ts";

test("FSH1 browser requests match host framing", () => {
  assert.deepEqual(
    [...encodeFileListRequest(0x0102_0304, "nested")],
    [202, 1, 0, 0, 1, 2, 3, 4, 0, 6, 110, 101, 115, 116, 101, 100],
  );
  assert.deepEqual(
    Array.from(encodeFileGetRequest(7, "file.txt", 0x0102_0304, 65_536).slice(-12)),
    [0, 0, 0, 0, 1, 2, 3, 4, 0, 1, 0, 0],
  );
  assert.equal(encodeFilePutBeginRequest(8, "upload.bin", 9)[1], 3);
  assert.deepEqual(
    [...encodeFilePutChunkRequest(8, new Uint8Array([1, 2, 3]))],
    [202, 4, 0, 0, 0, 0, 0, 8, 0, 0, 0, 3, 1, 2, 3],
  );
  assert.deepEqual([...encodeFilePutEndRequest(8)], [202, 5, 0, 0, 0, 0, 0, 8]);
  assert.deepEqual([...encodeFilePutAbortRequest(8)], [202, 7, 0, 0, 0, 0, 0, 8]);
  assert.equal(encodeFileMkdirRequest(9, "New Folder")[1], 6);
});

test("FSH1 browser parses capability, listing, chunks, and errors", async () => {
  assert.deepEqual(
    await readFileSharingMessage(new Bytes(new Uint8Array([1, 1, 0, 0, 6, ...utf8("Shared")]))),
    { kind: "capability", displayName: "Shared", allowWrites: true },
  );

  const listing = new Uint8Array([
    2,
    0,
    0,
    0,
    0,
    0,
    9,
    0,
    1,
    0,
    8,
    ...utf8("file.txt"),
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    7,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    10,
  ]);
  assert.deepEqual(await readFileSharingMessage(new Bytes(listing)), {
    kind: "list",
    id: 9,
    entries: [{ name: "file.txt", isDirectory: false, size: 7, modificationTimeMilliseconds: 10 }],
  });

  const chunk = new Uint8Array([3, 0, 1, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 3, 1, 2, 3]);
  assert.deepEqual(await readFileSharingMessage(new Bytes(chunk)), {
    kind: "chunk",
    id: 3,
    offset: 4,
    bytes: new Uint8Array([1, 2, 3]),
    endOfFile: true,
  });

  const failure = new Uint8Array([255, 1, 0, 0, 0, 0, 4, 0, 4, ...utf8("nope")]);
  assert.deepEqual(await readFileSharingMessage(new Bytes(failure)), {
    kind: "error",
    id: 4,
    message: "nope",
  });
});

test("FSH1 browser rejects oversized and malformed frames", async () => {
  assert.throws(
    () => encodeFilePutChunkRequest(1, new Uint8Array(maximumFileSharingChunkBytes + 1)),
    /invalid upload chunk/,
  );
  await assert.rejects(
    readFileSharingMessage(new Bytes(new Uint8Array([1, 1, 1, 0, 1, 65]))),
    /padding/,
  );
  await assert.rejects(
    readFileSharingMessage(new Bytes(new Uint8Array([2, 0, 0, 0, 0, 0, 1, 4, 1]))),
    /entry limit/,
  );
});

class Bytes {
  #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  async readExactly(count: number): Promise<Uint8Array> {
    if (this.#bytes.byteLength < count) throw new Error("short fixture");
    const result = this.#bytes.slice(0, count);
    this.#bytes = this.#bytes.slice(count);
    return result;
  }
}

function utf8(value: string): number[] {
  return [...new TextEncoder().encode(value)];
}
