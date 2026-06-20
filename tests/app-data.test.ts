import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createAppPolling,
  createRequestFence,
  defaultDeployment,
  initialAppState,
  reconcileLinkedSessionState,
  removeSharedLinkedSession,
  retainTokenBackedSession,
  retainLinkedSession,
  runAppPollingInterval,
  sameSharedLink,
  sharedSessionState,
  shouldAutoGithubLogin,
  upsertLinkedSession,
  upsertSharedLinkedSession,
} from "../src/app/app-data.js";

test("app data initializes and retains routed sessions across authenticated refreshes", () => {
  const initial = initialAppState({ id: "IS-1", token: "share" });
  assert.equal(initial.interactiveSessions[0].id, "IS-1");
  assert.equal(initial.interactiveSessions[0].sharedReadOnly, true);

  const linked = { id: "IS-1", repo: "openclaw/openclaw" };
  const next = retainLinkedSession({ interactiveSessions: [{ id: "IS-2" }] }, linked);
  assert.deepEqual(
    next.interactiveSessions.map((session: { id: string }) => session.id),
    ["IS-1", "IS-2"],
  );
  assert.equal(retainLinkedSession(next, linked), next);

  const authenticated = { ...next, user: { subject: "github:42" }, cards: [{ id: "C-1" }] };
  const replaced = upsertLinkedSession(authenticated, { ...linked, status: "ready" });
  assert.deepEqual(
    replaced.interactiveSessions.map((session: { id: string }) => session.id),
    ["IS-1", "IS-2"],
  );
  assert.equal(replaced.interactiveSessions[0].status, "ready");
  assert.equal(replaced.user, authenticated.user);
  assert.equal(replaced.cards, authenticated.cards);

  const tokenBacked = upsertSharedLinkedSession(authenticated, {
    id: "IS-3",
    status: "attached",
  });
  assert.equal(tokenBacked.interactiveSessions[0].sharedLinkOnly, true);
  assert.deepEqual(
    removeSharedLinkedSession(tokenBacked, "IS-3").interactiveSessions.map(
      (session: { id: string }) => session.id,
    ),
    ["IS-1", "IS-2"],
  );
  assert.equal(removeSharedLinkedSession(authenticated, "IS-1"), authenticated);
});

test("full-state responses retain token-backed sessions", () => {
  const linked = {
    id: "IS-shared",
    sharedLinkOnly: true,
    sharedReadOnly: true,
    status: "ready",
  };
  const current = { interactiveSessions: [{ id: "IS-owned" }, linked], cards: [] };
  const next = { interactiveSessions: [{ id: "IS-owned" }], cards: [{ id: "C-1" }] };
  const merged = retainTokenBackedSession(next, current);

  assert.deepEqual(
    merged.interactiveSessions.map((session: { id: string }) => session.id),
    ["IS-shared", "IS-owned"],
  );
  assert.equal(merged.cards, next.cards);
  assert.equal(retainTokenBackedSession(next, { interactiveSessions: [] }), next);
});

test("tokenless linked sessions are revalidated when absent from bounded state", async () => {
  const current = { id: "IS-linked", status: "ready", summary: "stale" };
  const base = { interactiveSessions: [{ id: "IS-owned" }] };
  const refreshed = await reconcileLinkedSessionState(base, current, {
    sharedToken: null,
    async loadSession(id: string) {
      assert.equal(id, "IS-linked");
      return { session: { ...current, summary: "fresh" } };
    },
  });
  assert.equal(refreshed.interactiveSessions[0].summary, "fresh");

  const revoked = await reconcileLinkedSessionState(base, current, {
    sharedToken: null,
    async loadSession() {
      throw Object.assign(new Error("not found"), { status: 404 });
    },
  });
  assert.equal(revoked, base);

  let tokenLoaderCalled = false;
  const tokenBacked = await reconcileLinkedSessionState(base, current, {
    sharedToken: "share-token",
    async loadSession() {
      tokenLoaderCalled = true;
      throw Object.assign(new Error("not found"), { status: 404 });
    },
  });
  assert.equal(tokenLoaderCalled, true);
  assert.deepEqual(
    tokenBacked.interactiveSessions.map((session: { id: string }) => session.id),
    ["IS-linked", "IS-owned"],
  );
  assert.equal(tokenBacked.interactiveSessions[0].sharedRevalidationPending, true);
  const redacted = upsertSharedLinkedSession(tokenBacked, {
    id: "IS-linked",
    status: "ready",
    canControl: false,
  });
  assert.equal(redacted.interactiveSessions[0].sharedLinkOnly, true);
  assert.equal(redacted.interactiveSessions[0].canControl, false);
  assert.deepEqual(
    removeSharedLinkedSession(tokenBacked, "IS-linked").interactiveSessions.map(
      (session: { id: string }) => session.id,
    ),
    ["IS-owned"],
  );
});

test("shared session state uses current auth and deployment metadata", () => {
  const auth = { github: true, token: false, devIdentity: false, trustedProxy: false };
  const deployment = { ...defaultDeployment, label: "Test Fleet" };
  const state = sharedSessionState({ id: "IS-1", repo: "openclaw/openclaw" }, auth, deployment);

  assert.equal(state.user.role, "viewer");
  assert.equal(state.auth, auth);
  assert.equal(state.deployment, deployment);
  assert.deepEqual(state.repos, ["openclaw/openclaw"]);
});

test("shared session identity fences both the session and credential", () => {
  assert.equal(sameSharedLink({ id: "IS-1", token: "one" }, { id: "IS-1", token: "one" }), true);
  assert.equal(sameSharedLink({ id: "IS-1", token: "one" }, { id: "IS-1", token: "two" }), false);
  assert.equal(sameSharedLink({ id: "IS-1", token: "one" }, { id: "IS-2", token: "one" }), false);
});

test("automatic GitHub login requires an explicit remembered login", () => {
  const base = {
    signedIn: false,
    started: false,
    methods: { github: true, token: true, devIdentity: false },
    shared: { id: null, token: null },
    tokenBypass: false,
    skipped: false,
    ready: true,
  };
  assert.equal(shouldAutoGithubLogin(base), true);
  assert.equal(shouldAutoGithubLogin({ ...base, signedIn: true }), false);
  assert.equal(shouldAutoGithubLogin({ ...base, tokenBypass: true }), false);
  assert.equal(shouldAutoGithubLogin({ ...base, shared: { id: "IS-1", token: "share" } }), false);
  assert.equal(shouldAutoGithubLogin({ ...base, ready: false }), false);
});

test("app polling owns one interval and one retry timer", () => {
  const calls: string[] = [];
  let interval: (() => void) | null = null;
  let retry: (() => void) | null = null;
  const cleared: unknown[] = [];
  const polling = createAppPolling({
    runInitial: () => calls.push("initial"),
    runInterval: () => calls.push("interval"),
    runRetry: () => calls.push("retry"),
    timers: {
      setInterval(callback: () => void, delay: number) {
        assert.equal(delay, 15000);
        interval = callback;
        return "interval";
      },
      clearInterval(id: unknown) {
        cleared.push(id);
      },
      setTimeout(callback: () => void, delay: number) {
        assert.equal(delay, 5000);
        retry = callback;
        return "retry";
      },
      clearTimeout(id: unknown) {
        cleared.push(id);
      },
    },
  });

  polling.start();
  polling.start();
  assert.deepEqual(calls, ["initial"]);
  interval?.();
  polling.scheduleRetry();
  polling.scheduleRetry();
  retry?.();
  assert.deepEqual(calls, ["initial", "interval", "retry"]);

  polling.scheduleRetry();
  polling.stop();
  assert.deepEqual(cleared, ["interval", "retry"]);
});

test("signed-in polling refreshes private and token-backed session state", async () => {
  const calls: string[] = [];
  await runAppPollingInterval({
    signedIn: true,
    shared: { id: "IS-shared", token: "ticket" },
    locked: false,
    async loadState() {
      calls.push("state");
    },
    async loadSharedSession(options: { preserveSignedIn: boolean; notify: boolean }) {
      calls.push(`shared:${options.preserveSignedIn}:${options.notify}`);
    },
    onSharedError() {
      calls.push("error");
    },
  });
  assert.deepEqual(calls, ["state", "shared:true:false"]);

  await runAppPollingInterval({
    signedIn: false,
    shared: { id: "IS-shared", token: "ticket" },
    locked: false,
    async loadState() {
      calls.push("unexpected-state");
    },
    async loadSharedSession(options: { preserveSignedIn: boolean; notify: boolean }) {
      calls.push(`anonymous:${options.preserveSignedIn}:${options.notify}`);
    },
  });
  assert.equal(calls.at(-1), "anonymous:false:false");
});

test("signed-in shared refresh reports revocation without changing auth mode", async () => {
  const contexts: unknown[] = [];
  await runAppPollingInterval({
    signedIn: true,
    shared: { id: "IS-shared", token: "revoked" },
    locked: false,
    async loadState() {},
    async loadSharedSession() {
      throw Object.assign(new Error("not found"), { status: 404 });
    },
    onSharedError(error: unknown, context: unknown) {
      contexts.push({ error, context });
    },
  });
  assert.equal(contexts.length, 1);
  assert.deepEqual((contexts[0] as { context: unknown }).context, {
    preserveSignedIn: true,
    notify: false,
    shared: { id: "IS-shared", token: "revoked" },
  });
});

test("shared session responses recheck current signed-in state before committing", async () => {
  const source = await readFile(new URL("../src/app/app-data.js", import.meta.url), "utf8");
  const sharedLoad = source.slice(
    source.indexOf("  async function performLoadSharedSession("),
    source.indexOf("  function loadSharedSession("),
  );

  assert.match(source, /signedInRef\.current = value;[\s\S]*setSignedIn\(value\);/);
  assert.equal(
    (sharedLoad.match(/commitSharedSessionToSignedInState\(linkedSession\)/g) || []).length,
    2,
  );
  assert.match(sharedLoad, /loadAuthMethods\(\)/);
  assert.match(
    source,
    /async function showSharedLinkError[\s\S]*?await loadAuthMethods\(\);[\s\S]*?signedInRef\.current[\s\S]*?showPreservedSharedLinkError/,
  );
  assert.match(
    source,
    /error\.status === 401 \|\| error\.status === 403[\s\S]*?clearAuthenticatedState\(sharedFallback\)[\s\S]*?forceSharedOnlyGeneration: generation/,
  );
  assert.match(source, /api\("\/api\/logout"[\s\S]*?clearAuthenticatedState\(\)/);
});

test("fresh state requests fence older responses", () => {
  const fence = createRequestFence();
  const passive = fence.next();
  assert.equal(fence.isCurrent(passive), true);
  const postMutation = fence.next();
  assert.equal(fence.isCurrent(passive), false);
  assert.equal(fence.isCurrent(postMutation), true);
});
