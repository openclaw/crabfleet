import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	boundedUtf8Tail,
	openClawBranchPreparationCanDefer,
	openClawRoomMaxSessions,
	openClawRoomRootAllowed,
	openClawRoomSessionAllowed,
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

test("OpenClaw branch preparation defers masked control-plane permission failures", () => {
	assert.equal(openClawBranchPreparationCanDefer(403), true);
	assert.equal(openClawBranchPreparationCanDefer(404), true);
	assert.equal(openClawBranchPreparationCanDefer(401), false);
	assert.equal(openClawBranchPreparationCanDefer(500), false);
});

test("session root fences accept the root and every child only for the exact root", () => {
	assert.equal(sessionBelongsToRoot("IS-10", "IS-10", "IS-10"), true);
	assert.equal(sessionBelongsToRoot("IS-11", "IS-10", "IS-10"), true);
	assert.equal(sessionBelongsToRoot("IS-11", "IS-10", "IS-99"), false);
	assert.equal(sessionBelongsToRoot("IS-10", null, "IS-10"), true);
	assert.equal(sessionBelongsToRoot("IS-10", null, ""), false);
});

test("room supervision accepts only service-created non-action trees", () => {
	const root = {
		id: "IS-10",
		rootSessionId: "IS-10",
		runtime: "container",
		createdBy: "service:openclaw",
		workKey: null,
	};
	assert.equal(openClawRoomSessionAllowed(root), true);
	assert.equal(openClawRoomRootAllowed(root), true);
	assert.equal(openClawRoomRootAllowed({ ...root, id: "IS-11" }), false);
	assert.equal(openClawRoomSessionAllowed({ ...root, runtime: "github_actions" }), false);
	assert.equal(openClawRoomSessionAllowed({ ...root, createdBy: "github:123" }), false);
	assert.equal(openClawRoomSessionAllowed({ ...root, workKey: "repo:pr:1" }), false);
});

test("bounded transcript tails remain valid UTF-8 and report truncation", () => {
	assert.deepEqual(boundedUtf8Tail("hello", 5), { text: "hello", truncated: false });
	assert.deepEqual(boundedUtf8Tail("hello", 4), { text: "ello", truncated: true });
	assert.deepEqual(boundedUtf8Tail("a\u00E9b", 2), { text: "b", truncated: true });
	assert.deepEqual(boundedUtf8Tail("\u{1F600}\u{1F600}", 5), {
		text: "\u{1F600}",
		truncated: true,
	});
	assert.ok(
		new TextEncoder().encode(boundedUtf8Tail("\u{1F600}\u{1F600}", 5).text).byteLength <= 5,
	);
	assert.equal(openClawTranscriptMaxBytes, 64 * 1024);
	assert.equal(openClawRoomMaxSessions, 64);
});

test("OpenClaw create preserves the already-decorated interactive session", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const createStart = source.indexOf("async function openClawCreateCrabbox");
	const createEnd = source.indexOf("async function openClawReadSessionRoot", createStart);
	const createSource = source.slice(createStart, createEnd);
	const responseStart = source.indexOf("function openClawDecoratedCrabboxResponse");
	const responseEnd = source.indexOf("async function openClawRegisterActionSession", responseStart);
	const responseSource = source.slice(responseStart, responseEnd);

	assert.match(createSource, /return openClawDecoratedCrabboxResponse\(env, result\.session\)/);
	assert.doesNotMatch(createSource, /openClawCrabboxResponse\(env, serviceUser, result\.session\)/);
	assert.doesNotMatch(responseSource, /decorateInteractiveSession/);
});

test("OpenClaw mutations persist request evidence before consequential work", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const messageStart = source.indexOf("async function openClawMessageCrabbox");
	const messageEnd = source.indexOf("async function openClawMutateCrabbox", messageStart);
	const messageSource = source.slice(messageStart, messageEnd);
	const stopStart = messageEnd;
	const stopEnd = source.indexOf("async function openClawRootScopedCrabbox", stopStart);
	const stopSource = source.slice(stopStart, stopEnd);

	assert.ok(
		messageSource.indexOf("OpenClaw service nudge requested") <
			messageSource.indexOf("openInteractiveTerminalUpstream"),
	);
	assert.match(messageSource, /Promise\.allSettled/);
	assert.ok(
		stopSource.indexOf("openclaw crabbox stop requested") <
			stopSource.indexOf("mutateInteractiveSession"),
	);
});

test("OpenClaw transcript reads a sentinel event before reporting completeness", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const transcriptStart = source.indexOf("async function openClawReadCrabboxTranscript");
	const transcriptEnd = source.indexOf("async function openClawMessageCrabbox", transcriptStart);
	const transcriptSource = source.slice(transcriptStart, transcriptEnd);

	assert.match(transcriptSource, /limit: 241, newest: true/);
	assert.match(transcriptSource, /const hasMoreEvents = eventWindow\.length > 240/);
	assert.match(transcriptSource, /eventWindow\.slice\(1\)/);
	assert.match(transcriptSource, /openClawCrabboxSummaryResponse/);
	assert.match(
		transcriptSource,
		/transcript\.truncated \|\| hasMoreEvents \|\| eventCount > events\.length/,
	);
});

test("OpenClaw root reads are filtered, capped, concurrent, and log-free", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const readStart = source.indexOf("async function openClawReadSessionRoot");
	const readEnd = source.indexOf("async function openClawReadCrabbox", readStart);
	const readSource = source.slice(readStart, readEnd);
	const summaryStart = source.indexOf("function openClawCrabboxSummaryResponse");
	const summaryEnd = source.indexOf("function openClawDecoratedCrabboxResponse", summaryStart);
	const summarySource = source.slice(summaryStart, summaryEnd);

	assert.match(readSource, /\.where\("created_by", "=", "service:openclaw"\)/);
	assert.match(readSource, /\.where\("runtime", "!=", "github_actions"\)/);
	assert.match(readSource, /\.where\("work_key", "is", null\)/);
	assert.match(readSource, /\.limit\(openClawRoomMaxSessions \+ 1\)/);
	assert.match(readSource, /mapWithConcurrency\(/);
	assert.match(readSource, /openClawCrabboxSummaryResponse/);
	assert.match(summarySource, /session: \{ \.\.\.response\.session, logs: \[\] \}/);
});
