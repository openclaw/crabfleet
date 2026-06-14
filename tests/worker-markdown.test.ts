import assert from "node:assert/strict";
import { test } from "node:test";

import { markdownToHtml } from "../scripts/worker-markdown.mjs";

test("Worker docs render Markdown and autolinks without touching code spans", () => {
  const html = markdownToHtml(
    "See [the spec](/spec/), [architecture](/architecture/), and <https://crabfleet.ai>.\n\n`[literal](/spec/)`",
  );

  assert.match(html, /<a href="\/docs\/spec">the spec<\/a>/);
  assert.match(html, /<a href="https:\/\/docs\.crabfleet\.ai\/architecture\/">architecture<\/a>/);
  assert.match(html, /<a href="https:\/\/crabfleet\.ai">https:\/\/crabfleet\.ai<\/a>/);
  assert.match(html, /<code>\[literal\]\(\/spec\/\)<\/code>/);
});
