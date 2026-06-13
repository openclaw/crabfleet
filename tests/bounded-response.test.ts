import assert from "node:assert/strict";
import test from "node:test";

import { readBoundedResponseText, ResponseBodyLimitError } from "../src/bounded-response.ts";

test("bounded response reader accepts a body exactly at the limit", async () => {
  const response = new Response("abcd", { headers: { "content-length": "4" } });
  assert.equal(await readBoundedResponseText(response, 4), "abcd");
});

test("bounded response reader rejects an oversized declared body before parsing", async () => {
  const response = new Response("small", { headers: { "content-length": "100" } });
  await assert.rejects(readBoundedResponseText(response, 8), ResponseBodyLimitError);
});

test("bounded response reader cancels an oversized chunked body", async () => {
  let canceled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234"));
        controller.enqueue(new TextEncoder().encode("56789"));
      },
      cancel() {
        canceled = true;
      },
    }),
  );

  await assert.rejects(readBoundedResponseText(response, 8), ResponseBodyLimitError);
  assert.equal(canceled, true);
});
