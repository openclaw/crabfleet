import assert from "node:assert/strict";
import test from "node:test";

import {
  createAppPolling,
  createRequestFence,
  defaultDeployment,
  initialAppState,
  retainLinkedSession,
  sameSharedLink,
  sharedSessionState,
  shouldAutoGithubLogin,
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

test("fresh state requests fence older responses", () => {
  const fence = createRequestFence();
  const passive = fence.next();
  assert.equal(fence.isCurrent(passive), true);
  const postMutation = fence.next();
  assert.equal(fence.isCurrent(passive), false);
  assert.equal(fence.isCurrent(postMutation), true);
});
