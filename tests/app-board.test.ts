import assert from "node:assert/strict";
import test from "node:test";

import { matchesCard, visibleBoardCards } from "../src/app/board-state.js";

const cards = [
  {
    id: "C-1",
    title: "Fix terminal",
    owner: "alice",
    lane: "Running",
    repo: "openclaw/openclaw",
    source: "Issue",
    runtime: "container",
    policy: "guarded",
    changes: { files: [{ path: "src/terminal.ts" }] },
  },
  {
    id: "C-2",
    title: "Update docs",
    owner: "bob",
    lane: "Todo",
    repo: "openclaw/docs",
    source: "Prompt",
    runtime: "crabbox",
    policy: "open_pr",
    changes: { files: [] },
  },
];

test("board search covers card metadata and changed paths", () => {
  assert.equal(matchesCard(cards[0], "terminal.ts"), true);
  assert.equal(matchesCard(cards[1], "CRABBOX"), true);
  assert.equal(matchesCard(cards[1], "missing"), false);
});

test("board filters compose with normalized search", () => {
  assert.deepEqual(
    visibleBoardCards(cards, { filter: "mine", current: "alice", query: " OPENCLAW " }).map(
      (card) => card.id,
    ),
    ["C-1"],
  );
  assert.deepEqual(
    visibleBoardCards(cards, { filter: "hot", current: "alice", query: "" }).map((card) => card.id),
    ["C-1"],
  );
});
