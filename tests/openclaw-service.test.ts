import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	boundedUtf8Tail,
	openClawBranchPreparationCanDefer,
	openClawGitBranchAllowed,
	openClawGitHubRepoParts,
	openClawRoomMaxSessions,
	openClawRoomRootAllowed,
	openClawRoomSessionChainAllowed,
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

test("OpenClaw GitHub branch writes reject lossy or invalid refs", () => {
	assert.equal(openClawGitBranchAllowed("main"), true);
	assert.equal(openClawGitBranchAllowed("feature/team-room"), true);
	assert.equal(openClawGitBranchAllowed("x".repeat(120)), true);
	assert.equal(openClawGitBranchAllowed("x".repeat(121)), false);
	assert.equal(openClawGitBranchAllowed("feature/team-room "), false);
	assert.equal(openClawGitBranchAllowed("feature//team-room"), false);
	assert.equal(openClawGitBranchAllowed("feature/../team-room"), false);
	assert.equal(openClawGitBranchAllowed("feature/team-room.lock"), false);
});

test("OpenClaw GitHub writes require one exact owner/name pair", () => {
	assert.deepEqual(openClawGitHubRepoParts("openclaw/crabfleet"), {
		owner: "openclaw",
		name: "crabfleet",
	});
	assert.equal(openClawGitHubRepoParts("openclaw/crabfleet/extra"), null);
	assert.equal(openClawGitHubRepoParts("openclaw/crabfleet?ref=main"), null);
	assert.equal(openClawGitHubRepoParts("open_claw/crabfleet"), null);
	assert.equal(openClawGitHubRepoParts("openclaw/"), null);
});

test("session root fences accept the root and every child only for the exact root", () => {
	assert.equal(sessionBelongsToRoot("IS-10", "IS-10", "IS-10"), true);
	assert.equal(sessionBelongsToRoot("IS-11", "IS-10", "IS-10"), true);
	assert.equal(sessionBelongsToRoot("IS-11", "IS-10", "IS-99"), false);
	assert.equal(sessionBelongsToRoot("IS-10", null, "IS-10"), true);
	assert.equal(sessionBelongsToRoot("IS-10", null, ""), false);
});

test("room supervision accepts service roots and their agent-created non-action descendants", () => {
	const root = {
		id: "IS-10",
		parentSessionId: null,
		rootSessionId: "IS-10",
		runtime: "container",
		createdBy: "service:openclaw",
		workKey: null,
	};
	assert.equal(openClawRoomSessionAllowed(root), true);
	assert.equal(openClawRoomRootAllowed(root), true);
	assert.equal(openClawRoomRootAllowed({ ...root, id: "IS-11" }), false);
	assert.equal(
		openClawRoomSessionAllowed({
			...root,
			id: "IS-11",
			parentSessionId: "IS-10",
			createdBy: "session:IS-10",
		}),
		true,
	);
	assert.equal(openClawRoomRootAllowed({ ...root, createdBy: "session:IS-10" }), false);
	assert.equal(openClawRoomSessionAllowed({ ...root, runtime: "github_actions" }), false);
	assert.equal(openClawRoomSessionAllowed({ ...root, createdBy: "github:123" }), false);
	assert.equal(openClawRoomSessionAllowed({ ...root, workKey: "repo:pr:1" }), false);

	const child = { ...root, id: "IS-11", parentSessionId: "IS-10" };
	const agent = {
		...root,
		id: "IS-12",
		parentSessionId: "IS-11",
		createdBy: "session:IS-11",
	};
	assert.equal(openClawRoomSessionChainAllowed([root, child, agent], agent.id, root.id), true);
	assert.equal(openClawRoomSessionChainAllowed([root, agent], agent.id, root.id), false);
	assert.equal(
		openClawRoomSessionChainAllowed(
			[root, { ...child, createdBy: "github:123" }, agent],
			agent.id,
			root.id,
		),
		false,
	);
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
	assert.match(createSource, /AbortSignal\.timeout\(openClawPreparationTimeoutMs\)/);
	assert.match(createSource, /ensureOpenClawServiceBranch\([\s\S]*signal\)/);
	assert.match(createSource, /if \(signal\.aborted\)/);
	assert.match(createSource, /openClawServiceBranch\(body\.branch, "branch", "main"\)/);

	const branchStart = source.indexOf("async function ensureOpenClawServiceBranch");
	const branchEnd = source.indexOf("function actionWorkIdentifier", branchStart);
	const branchSource = source.slice(branchStart, branchEnd);
	assert.match(branchSource, /openClawServiceBranch\(branchInput, "branch", "main"\)/);
	assert.match(branchSource, /openClawServiceBranch\(baseBranchInput, "baseBranch"\)/);
	assert.doesNotMatch(branchSource, /clean\(branch/);
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

test("OpenClaw root reads are filtered, capped, D1-only, and log-free", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const readStart = source.indexOf("async function openClawReadSessionRoot");
	const readEnd = source.indexOf("async function openClawMutateSessionRoot", readStart);
	const readSource = source.slice(readStart, readEnd);
	const summaryStart = source.indexOf("function openClawCrabboxSummaryResponse");
	const summaryEnd = source.indexOf("function openClawDecoratedCrabboxResponse", summaryStart);
	const summarySource = source.slice(summaryStart, summaryEnd);

	assert.match(readSource, /expression\("created_by", "=", "service:openclaw"\)/);
	assert.match(readSource, /expression\("created_by", "like", "session:%"\)/);
	assert.match(readSource, /\.where\("runtime", "!=", "github_actions"\)/);
	assert.match(readSource, /\.where\("work_key", "is", null\)/);
	assert.match(readSource, /\.where\("preparation_pending", "=", 0\)/);
	assert.match(readSource, /\.limit\(openClawRoomMaxSessions \+ 1\)/);
	assert.doesNotMatch(readSource, /readFreshInteractiveSession/);
	assert.doesNotMatch(readSource, /mapWithConcurrency\(/);
	assert.match(readSource, /openClawRoomSessionChainAllowed/);
	assert.match(readSource, /openClawCrabboxSummaryResponse/);
	assert.match(summarySource, /session: \{ \.\.\.response\.session, logs: \[\] \}/);
});

test("OpenClaw target authorization precedes targeted reconciliation", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const scopedStart = source.indexOf("async function openClawRootScopedCrabbox");
	const scopedEnd = source.indexOf("async function openClawReadSessionChain", scopedStart);
	const scopedSource = source.slice(scopedStart, scopedEnd);
	const chainStart = scopedEnd;
	const chainEnd = source.indexOf("async function openClawSupervisedRootForCreate", chainStart);
	const chainSource = source.slice(chainStart, chainEnd);

	assert.ok(
		scopedSource.indexOf("openClawRoomSessionChainAllowed") <
			scopedSource.indexOf("readFreshInteractiveSession"),
	);
	assert.match(scopedSource, /const session = await readInteractiveSession/);
	assert.match(scopedSource, /const root = await readInteractiveSession/);
	assert.doesNotMatch(chainSource, /readFreshInteractiveSession/);
});

test("interactive lineage rejects caller-claimed roots without a parent", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const start = source.indexOf("async function resolveInteractiveSessionLineage");
	const end = source.indexOf("function interactiveSessionPurpose", start);
	const lineageSource = source.slice(start, end);

	assert.match(
		lineageSource,
		/if \(rootId\) throw badRequest\("root session id requires a parent session id"\)/,
	);
});

test("OpenClaw room reservation precedes branch mutation, event recording, and provisioning", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const migration = await readFile(
		new URL("../migrations/0025_interactive_session_preparation.sql", import.meta.url),
		"utf8",
	);
	const capacityStart = source.indexOf("async function enforceOpenClawRoomSessionLimitAfterInsert");
	const capacityEnd = source.indexOf("function openClawCrabboxResponse", capacityStart);
	const capacitySource = source.slice(capacityStart, capacityEnd);
	const activationStart = source.indexOf("async function activateInteractiveSessionReservation");
	const activationEnd = source.indexOf("function openClawCrabboxResponse", activationStart);
	const activationSource = source.slice(activationStart, activationEnd);
	const rollbackStart = source.indexOf("async function rollbackInteractiveSessionReservation");
	const rollbackEnd = source.indexOf("async function activateInteractiveSessionReservation");
	const rollbackSource = source.slice(rollbackStart, rollbackEnd);
	const createStart = source.indexOf("async function createInteractiveSessionFromInput");
	const createEnd = source.indexOf("function initialRuntimeAdapterWorkspaceId", createStart);
	const createSource = source.slice(createStart, createEnd);
	const readStart = source.indexOf("async function readInteractiveSessions");
	const readEnd = source.indexOf("async function readSharedInteractiveSession", readStart);
	const readSource = source.slice(readStart, readEnd);

	assert.match(migration, /ADD COLUMN preparation_pending INTEGER NOT NULL DEFAULT 0/);
	assert.match(capacitySource, /inserted\.rowid AS inserted_rowid/);
	assert.match(capacitySource, /candidate\.rowid <= inserted\.rowid/);
	assert.match(capacitySource, /GROUP BY inserted\.rowid/);
	assert.match(capacitySource, /openClawRoomReservationLineageAllowed/);
	assert.match(capacitySource, /readOpenClawLineageSession\(env, insertedSessionId, 1\)/);
	assert.match(capacitySource, /readOpenClawLineageSession\(env, rootSessionId, 0\)/);
	assert.ok(
		capacitySource.indexOf("openClawRoomReservationLineageAllowed") <
			capacitySource.indexOf("inserted.rowid AS inserted_rowid"),
	);
	assert.match(capacitySource, /deleteFrom\("interactive_sessions"\)/);
	assert.match(
		capacitySource,
		/throw tooManyRequests\("session root reached the supervision limit"\)/,
	);
	assert.match(activationSource, /adapter: runtimeAdapterName/);
	assert.match(activationSource, /adapter_create_pending: 1/);
	assert.match(activationSource, /preparation_pending: 0/);
	assert.match(activationSource, /\.where\("preparation_pending", "=", 1\)/);
	assert.match(activationSource, /\.where\("adapter", "is", null\)/);
	assert.match(activationSource, /\.where\("adapter_create_pending", "=", 0\)/);
	assert.match(rollbackSource, /executeBatch\(env,/);
	assert.match(rollbackSource, /deleteFrom\("interactive_session_events"\)/);
	assert.match(rollbackSource, /deleteFrom\("interactive_session_log_archives"\)/);
	assert.match(capacitySource, /cleanupAbandonedInteractiveSessionPreparations/);
	assert.match(capacitySource, /interactiveSessionPreparationStaleMs/);
	assert.match(readSource, /\.where\("preparation_pending", "=", 0\)/);
	assert.match(
		createSource,
		/adapter: adapterWorkspaceId && !preparationReservation \? runtimeAdapterName : null/,
	);
	assert.match(
		createSource,
		/adapter_create_pending: adapterWorkspaceId && !preparationReservation \? 1 : 0/,
	);
	assert.match(
		createSource,
		/const preparationReservation = Boolean\(options\.afterReserve \|\| supervisedRootSessionId\)/,
	);
	assert.match(createSource, /preparation_pending: preparationReservation \? 1 : 0/);
	assert.ok(
		createSource.indexOf("enforceOpenClawRoomSessionLimitAfterInsert") <
			createSource.indexOf("await options.afterReserve"),
	);
	assert.ok(
		createSource.indexOf("await options.afterReserve") <
			createSource.indexOf("activateInteractiveSessionReservation"),
	);
	assert.ok(
		createSource.indexOf("activateInteractiveSessionReservation") <
			createSource.indexOf("appendInteractiveSessionEvent"),
	);
	assert.ok(
		createSource.indexOf("await options.afterReserve") <
			createSource.indexOf("provisionInteractiveSession"),
	);
	assert.match(
		createSource,
		/catch \(error\) \{\s+await rollbackInteractiveSessionReservation\(env, id, now\);\s+throw error;/,
	);
});

test("invalid descendants below an OpenClaw root fail closed before insertion", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const lineageStart = source.indexOf("async function openClawSupervisedRootForCreate");
	const lineageEnd = source.indexOf(
		"async function enforceOpenClawRoomSessionLimitAfterInsert",
		lineageStart,
	);
	const lineageSource = source.slice(lineageStart, lineageEnd);

	assert.match(
		lineageSource,
		/if \(!parent \|\| !root\) throw badRequest\("session lineage not found"\)/,
	);
	assert.match(
		lineageSource,
		/if \(createdBy === "service:openclaw" \|\| openClawRoomRootAllowed\(root\)\)/,
	);
	assert.match(lineageSource, /throw badRequest\("invalid OpenClaw room lineage"\)/);
});

test("OpenClaw crabbox requests reserve durable idempotency before provisioning", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const migration = await readFile(
		new URL("../migrations/0026_openclaw_lifecycle_guarantees.sql", import.meta.url),
		"utf8",
	);
	const endpointStart = source.indexOf("async function openClawCreateCrabbox");
	const endpointEnd = source.indexOf("async function openClawCrabboxRequestHash", endpointStart);
	const endpointSource = source.slice(endpointStart, endpointEnd);
	const replayStart = source.indexOf("async function readOpenClawRequestSession");
	const replayEnd = source.indexOf("async function openClawReadSessionRoot", replayStart);
	const replaySource = source.slice(replayStart, replayEnd);
	const createStart = source.indexOf("async function createInteractiveSessionFromInput");
	const createEnd = source.indexOf("function initialRuntimeAdapterWorkspaceId", createStart);
	const createSource = source.slice(createStart, createEnd);
	const rollbackStart = source.indexOf("async function rollbackInteractiveSessionReservation");
	const rollbackEnd = source.indexOf(
		"async function cleanupAbandonedInteractiveSessionPreparations",
		rollbackStart,
	);
	const rollbackSource = source.slice(rollbackStart, rollbackEnd);

	assert.match(migration, /ADD COLUMN openclaw_request_id TEXT/);
	assert.match(migration, /UNIQUE INDEX IF NOT EXISTS idx_interactive_sessions_openclaw_request/);
	assert.match(migration, /CREATE TABLE IF NOT EXISTS openclaw_request_replays/);
	assert.match(endpointSource, /readOpenClawRequestSession/);
	assert.match(endpointSource, /requestId must be at most 200 characters/);
	assert.ok(
		endpointSource.indexOf("readOpenClawRequestSession") <
			endpointSource.indexOf("createInteractiveSessionFromInput"),
	);
	assert.match(source, /profile: clean\(body\.profile, 120\)/);
	assert.match(source, /githubTokenHash: githubToken \? await sha256\(githubToken\) : null/);
	assert.match(replaySource, /row\.preparation_pending !== 0/);
	assert.match(replaySource, /OpenClaw crabbox request is still preparing/);
	assert.match(replaySource, /OpenClaw crabbox request already completed and is no longer available/);
	assert.match(replaySource, /\.selectFrom\("openclaw_request_replays as replay"\)/);
	assert.match(replaySource, /\.leftJoin\("interactive_sessions as session"/);
	assert.match(createSource, /openclaw_request_id: options\.openClawRequestId \?\? null/);
	assert.match(createSource, /openclaw_request_hash: options\.openClawRequestHash \?\? null/);
	assert.match(createSource, /\.insertInto\("openclaw_request_replays"\)/);
	assert.match(createSource, /if \(isConstraintError\(error\) && options\.openClawRequestId/);
	assert.match(rollbackSource, /\.deleteFrom\("openclaw_request_replays"\)/);
});

test("OpenClaw root stop freezes admission and drives pending descendants terminal", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const routeStart = source.indexOf("const openClawSessionRootActionMatch");
	const routeEnd = source.indexOf("const openClawCrabboxTranscriptMatch", routeStart);
	const routeSource = source.slice(routeStart, routeEnd);
	const stopStart = source.indexOf("async function openClawMutateSessionRoot");
	const stopEnd = source.indexOf("async function openClawReadCrabbox", stopStart);
	const stopSource = source.slice(stopStart, stopEnd);
	const lineageStart = source.indexOf("async function openClawSupervisedRootForCreate");
	const lineageEnd = source.indexOf("async function openClawRoomReservationLineageAllowed");
	const lineageSource = source.slice(lineageStart, lineageEnd);

	assert.match(routeSource, /openClawMutateSessionRoot/);
	assert.match(stopSource, /openclaw_admission_closed: 1/);
	assert.ok(
		stopSource.indexOf("openclaw session root stop requested") <
			stopSource.indexOf("openclaw_admission_closed: 1"),
	);
	assert.ok(
		stopSource.indexOf("openclaw_admission_closed: 1") <
			stopSource.indexOf("rollbackInteractiveSessionReservation"),
	);
	assert.ok(
		stopSource.indexOf("rollbackInteractiveSessionReservation") <
			stopSource.indexOf("mutateInteractiveSession"),
	);
	assert.match(stopSource, /terminalReads >= 2/);
	assert.match(stopSource, /completion\.remaining === 0/);
	assert.match(stopSource, /nextLifecycleAttemptAt/);
	assert.match(
		stopSource,
		/session\.status === "stopping" && session\.adapter !== runtimeAdapterName/,
	);
	assert.match(stopSource, /reconcileExternalInteractiveSessionById/);
	assert.match(stopSource, /runOpenClawRootOperationBeforeDeadline/);
	assert.match(stopSource, /\.slice\(0, 4\)/);
	assert.match(stopSource, /Math\.min\(2_000, pollDelayMs \* 2\)/);
	assert.doesNotMatch(stopSource, /session root exceeds the supervision limit/);
	assert.doesNotMatch(stopSource, /openClawRoomSessionChainAllowed/);
	assert.match(lineageSource, /openClawRootAdmissionOpen/);
	assert.match(lineageSource, /room_root\.openclaw_admission_closed = 0/);
	assert.match(
		lineageSource,
		/if \(!position\) \{\s+await rollbackInteractiveSessionReservation[\s\S]+throw conflict\("OpenClaw room root is stopping"\)/,
	);
});

test("OpenClaw lifecycle guarantees are documented", async () => {
	const docs = await readFile(new URL("../docs/api.md", import.meta.url), "utf8");
	assert.match(docs, /requestId/);
	assert.match(docs, /session-roots\/:rootSessionId\/actions/);
	assert.match(docs, /freeze room-tree\s+admission/);
});
