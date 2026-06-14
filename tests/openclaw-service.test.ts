import assert from "node:assert/strict";
import test from "node:test";

import {
	boundedUtf8Tail,
	openClawBranchPreparationCanDefer,
	openClawServiceAuthorized,
	openClawTranscriptMaxBytes,
	sessionBelongsToRoot,
} from "../src/openclaw-service.ts";

test("OpenClaw service authorization accepts dedicated scoped consumers", () => {
	assert.equal(openClawServiceAuthorized("Bearer openclaw", ["openclaw", "multicodex"]), true);
	assert.equal(openClawServiceAuthorized("Bearer multicodex", ["openclaw", "multicodex"]), true);
	assert.equal(openClawServiceAuthorized("Bearer public", ["openclaw", "multicodex"]), false);
	assert.equal(openClawServiceAuthorized(null, [undefined, null]), false);
});

test("OpenClaw branch preparation defers only control-plane permission failures", () => {
	assert.equal(openClawBranchPreparationCanDefer(403), true);
	assert.equal(openClawBranchPreparationCanDefer(401), false);
	assert.equal(openClawBranchPreparationCanDefer(404), false);
	assert.equal(openClawBranchPreparationCanDefer(500), false);
});

test("session root fences accept the root and every child only for the exact root", () => {
	assert.equal(sessionBelongsToRoot("IS-10", "IS-10", "IS-10"), true);
	assert.equal(sessionBelongsToRoot("IS-11", "IS-10", "IS-10"), true);
	assert.equal(sessionBelongsToRoot("IS-11", "IS-10", "IS-99"), false);
	assert.equal(sessionBelongsToRoot("IS-10", null, "IS-10"), true);
	assert.equal(sessionBelongsToRoot("IS-10", null, ""), false);
});

test("bounded transcript tails remain valid UTF-8 and report truncation", () => {
	assert.deepEqual(boundedUtf8Tail("hello", 5), { text: "hello", truncated: false });
	assert.deepEqual(boundedUtf8Tail("hello", 4), { text: "ello", truncated: true });
	assert.deepEqual(boundedUtf8Tail("a\u00E9b", 2), { text: "b", truncated: true });
	assert.equal(openClawTranscriptMaxBytes, 64 * 1024);
});
