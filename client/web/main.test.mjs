import assert from "node:assert/strict";
import { test } from "node:test";
import { startClient } from "./main.js";

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture({ init = async () => {}, start = async () => {} } = {}) {
  const window = new EventTarget();
  const document = new EventTarget();
  const instances = [];
  const loading = {
    textContent: "Loading",
    removed: false,
    remove() {
      this.removed = true;
    },
  };
  let reloads = 0;
  window.location = {
    search: "",
    reload() {
      reloads++;
    },
  };
  window.fetch = async (_, options) => {
    assert.equal(options.credentials, "omit");
    assert.equal(options.mode, "same-origin");
    return { ok: true, json: async () => ({ service: "crabfleet-web-gateway", version: 1 }) };
  };
  document.hidden = false;
  document.hasFocus = () => true;
  document.getElementById = (id) => (id === "loading" ? loading : {});
  class WebHandle {
    destroyed = 0;
    released = 0;
    constructor() {
      instances.push(this);
    }
    start = start;
    release_input() {
      this.released++;
    }
    destroy() {
      this.destroyed++;
    }
  }
  return {
    window,
    document,
    loading,
    instances,
    reloads: () => reloads,
    loadViewer: async () => ({ default: init, WebHandle }),
  };
}
function restored(window) {
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: true });
  window.dispatchEvent(event);
}

test("blur and hiding release input immediately; navigation tears down and Back reloads", async () => {
  const f = fixture();
  await startClient(f);
  const client = f.instances[0];
  assert.equal(f.window.crabfleet, client);
  assert.equal(f.loading.removed, true);
  f.window.dispatchEvent(new Event("blur"));
  f.document.hidden = true;
  f.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(client.released, 2);
  f.window.dispatchEvent(new Event("pagehide"));
  assert.equal(client.destroyed, 1);
  assert.equal(f.window.crabfleet, undefined);
  f.window.dispatchEvent(new Event("blur"));
  assert.equal(client.released, 3, "Old input listeners survived teardown");
  f.window.dispatchEvent(new Event("pageshow"));
  assert.equal(f.reloads(), 0);
  restored(f.window);
  assert.equal(f.reloads(), 1);
});

test("navigation cancels the health request before a viewer is constructed", async () => {
  const f = fixture();
  let signal;
  f.window.fetch = (_, options) => {
    signal = options.signal;
    return new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
  };
  const boot = startClient(f);
  f.window.dispatchEvent(new Event("pagehide"));
  await boot;
  assert.equal(signal.aborted, true);
  assert.equal(f.instances.length, 0);
  assert.equal(f.loading.textContent, "Loading");
});

test("a late WASM initialization cannot recreate a retired viewer", async () => {
  const ready = deferred();
  const entered = deferred();
  const f = fixture({
    init: async () => {
      entered.resolve();
      await ready.promise;
    },
  });
  const boot = startClient(f);
  await entered.promise;
  f.window.dispatchEvent(new Event("pagehide"));
  ready.resolve();
  await boot;
  assert.equal(f.instances.length, 0);
  assert.equal(f.window.crabfleet, undefined);
});

test("a late GPU initialization is destroyed again after it settles", async () => {
  const ready = deferred();
  const entered = deferred();
  const f = fixture({
    start: async () => {
      entered.resolve();
      await ready.promise;
    },
  });
  const boot = startClient(f);
  await entered.promise;
  f.window.dispatchEvent(new Event("pagehide"));
  assert.equal(f.instances[0].destroyed, 1);
  ready.resolve();
  await boot;
  assert.equal(f.instances[0].destroyed, 2);
  assert.equal(f.window.crabfleet, undefined);
  assert.equal(f.loading.removed, false);
});

test("failed startup retires its app and reports only a local error", async () => {
  const f = fixture({
    start: async () => {
      throw new Error("private renderer detail");
    },
  });
  await startClient(f);
  assert.ok(f.instances[0].destroyed >= 1);
  assert.match(f.loading.textContent, /could not start/);
  assert.doesNotMatch(f.loading.textContent, /private/);
  const releases = f.instances[0].released;
  f.window.dispatchEvent(new Event("blur"));
  assert.equal(f.instances[0].released, releases);
});
