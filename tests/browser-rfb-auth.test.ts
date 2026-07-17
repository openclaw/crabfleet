import assert from "node:assert/strict";
import test from "node:test";

import { browserDirectRFBAuthentication } from "../src/app/rfb/browser-auth.ts";

test("browser direct auth caches successful prompted credentials per tab", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  const first = await browserDirectRFBAuthentication(
    "test-host",
    storage,
    () => "test-ownership-token-1",
  );
  first.onVNCAuthentication(true);

  const second = await browserDirectRFBAuthentication("test-host", storage, () => {
    throw new Error("cached password should avoid prompting");
  });
  assert.equal(second.password, "test-ownership-token-1");
  second.onVNCAuthentication(false);
  assert.equal(values.size, 0);
});

test("browser direct auth treats unavailable session storage as best effort", async () => {
  const storage = {
    getItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("full", "QuotaExceededError");
    },
    removeItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
  };
  const authentication = await browserDirectRFBAuthentication(
    "test-host",
    storage,
    () => "test-ownership-token-1",
  );

  assert.equal(authentication.password, "test-ownership-token-1");
  assert.doesNotThrow(() => authentication.onVNCAuthentication(true));
  assert.doesNotThrow(() => authentication.onVNCAuthentication(false));

  const noStorage = await browserDirectRFBAuthentication(
    "test-host",
    null,
    () => "test-ownership-token-2",
  );
  assert.equal(noStorage.password, "test-ownership-token-2");
  assert.doesNotThrow(() => noStorage.onVNCAuthentication(true));
});
