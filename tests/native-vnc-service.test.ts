import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { AdapterNativeVNCGrant } from "../src/runtime-adapter.ts";
import type { User } from "../src/worker/models.ts";
import { NativeVNCService } from "../src/worker/native-vnc-service.ts";
import {
  interactiveSession,
  interactiveSessionAdapterControlPlane,
  type InteractiveSession,
} from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

const owner: User = {
  subject: "github:1",
  login: "owner",
  email: null,
  name: "Owner",
  role: "viewer",
  allowed: true,
  teams: [],
};

const grant: AdapterNativeVNCGrant = {
  brokerUrl: "wss://broker.example/native",
  leaseId: "lease-1",
  ticket: "ticket-1",
  expiresAt: 1_000,
};

// A native-VNC-eligible session in a given lifecycle status. status + canControl are set explicitly
// so the test is independent of how interactiveSession derives them.
function nativeSession(status: string): InteractiveSession {
  const base = interactiveSession(
    sessionRow({
      adapter: "runtime-v1",
      adapter_workspace_id: "workspace-1",
      adapter_control_plane: "cp1",
      capabilities_json: JSON.stringify({ nativeVnc: true }),
      created_by: owner.subject,
      owner: owner.subject,
      profile: "desktop",
      runtime: "crabbox",
    }),
    [],
  );
  return { ...base, status: status as InteractiveSession["status"], canControl: true };
}

function statusCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status: unknown }).status)
    : undefined;
}

test("native VNC mints a grant for a live session", async () => {
  const service = new NativeVNCService({
    readSession: async () => nativeSession("ready"),
    mintGrant: async () => grant,
  });
  assert.deepEqual(await service.createGrant(owner, "IS-1"), grant);
});

test("native VNC rejects a stopping session before minting", async () => {
  const calls: string[] = [];
  const service = new NativeVNCService({
    readSession: async () => nativeSession("stopping"),
    mintGrant: async () => {
      calls.push("mint");
      return grant;
    },
  });
  await assert.rejects(
    () => service.createGrant(owner, "IS-1"),
    (error) => {
      assert.equal(statusCode(error), 409);
      return true;
    },
  );
  assert.deepEqual(calls, [], "must not mint a grant for a session that is not live");
});

test("native VNC fails closed when the session begins teardown during the mint", async () => {
  let reads = 0;
  const service = new NativeVNCService({
    // live at the pre-mint check, stopping by the post-mint re-validation.
    readSession: async () => {
      reads += 1;
      return nativeSession(reads === 1 ? "ready" : "stopping");
    },
    mintGrant: async () => grant,
  });
  await assert.rejects(
    () => service.createGrant(owner, "IS-1"),
    (error) => {
      assert.equal(statusCode(error), 409);
      return true;
    },
  );
  assert.equal(reads, 2, "re-reads the session after the mint to catch a concurrent stop");
});

test("native VNC fails closed when control is revoked during the mint", async () => {
  let reads = 0;
  const service = new NativeVNCService({
    // controllable at the pre-mint check, control revoked by the post-mint re-validation.
    readSession: async () => {
      reads += 1;
      return { ...nativeSession("ready"), canControl: reads === 1 };
    },
    mintGrant: async () => grant,
  });
  await assert.rejects(
    () => service.createGrant(owner, "IS-1"),
    (error) => {
      assert.equal(statusCode(error), 409);
      return true;
    },
  );
  assert.equal(reads, 2, "re-checks control authorization after the mint, not just status");
});

test("native VNC fails closed when the control-plane is re-bound during the mint", async () => {
  let reads = 0;
  const service = new NativeVNCService({
    // same session, but its control-plane moves during the mint round trip.
    readSession: async () => {
      reads += 1;
      const session = nativeSession("ready");
      return reads === 1 ? session : { ...session, [interactiveSessionAdapterControlPlane]: "cp2" };
    },
    mintGrant: async () => grant,
  });
  await assert.rejects(
    () => service.createGrant(owner, "IS-1"),
    (error) => {
      assert.equal(statusCode(error), 409);
      return true;
    },
  );
  assert.equal(reads, 2, "re-checks the control-plane binding after the mint");
});

test("native VNC fails closed when the provider resource is re-bound during the mint", async () => {
  let reads = 0;
  const service = new NativeVNCService({
    // session reconciliation can rewrite providerResourceId while the session stays live.
    readSession: async () => {
      reads += 1;
      return { ...nativeSession("ready"), providerResourceId: reads === 1 ? "p1" : "p2" };
    },
    mintGrant: async () => grant,
  });
  await assert.rejects(
    () => service.createGrant(owner, "IS-1"),
    (error) => {
      assert.equal(statusCode(error), 409);
      return true;
    },
  );
  assert.equal(reads, 2, "re-checks the provider-resource binding after the mint");
});

test("native VNC fails closed when the profile changes during the mint", async () => {
  let reads = 0;
  const service = new NativeVNCService({
    readSession: async () => {
      reads += 1;
      return { ...nativeSession("ready"), profile: reads === 1 ? "desktop" : "other" };
    },
    mintGrant: async () => grant,
  });
  await assert.rejects(
    () => service.createGrant(owner, "IS-1"),
    (error) => {
      assert.equal(statusCode(error), 409);
      return true;
    },
  );
  assert.equal(reads, 2, "re-checks the profile after the mint");
});

test("native VNC rejects a missing or uncontrollable session", async () => {
  const mint = async () => grant;
  await assert.rejects(
    () =>
      new NativeVNCService({ readSession: async () => null, mintGrant: mint }).createGrant(
        owner,
        "IS-1",
      ),
    (error) => {
      assert.equal(statusCode(error), 404);
      return true;
    },
  );
  await assert.rejects(
    () =>
      new NativeVNCService({
        readSession: async () => ({ ...nativeSession("ready"), canControl: false }),
        mintGrant: mint,
      }).createGrant(owner, "IS-1"),
    (error) => {
      assert.equal(statusCode(error), 403);
      return true;
    },
  );
});

test("native VNC rejects sessions ineligible for native VNC", async () => {
  const base = nativeSession("ready");
  const ineligible: InteractiveSession[] = [
    { ...base, runtime: "container" },
    { ...base, adapter: "container-v1" },
    { ...base, capabilities: { ...base.capabilities, nativeVnc: false } },
    { ...base, adapterWorkspaceId: null },
    { ...base, [interactiveSessionAdapterControlPlane]: null },
  ];
  for (const session of ineligible) {
    const mints: string[] = [];
    await assert.rejects(
      () =>
        new NativeVNCService({
          readSession: async () => session,
          mintGrant: async () => {
            mints.push("mint");
            return grant;
          },
        }).createGrant(owner, "IS-1"),
      (error) => {
        assert.equal(statusCode(error), 409);
        return true;
      },
    );
    assert.deepEqual(mints, [], "an ineligible session must never reach the mint");
  }
});

// The service is only load-bearing if the production native-VNC route actually delegates to it.
// worker-application.ts can't be imported under `node --test` (its module graph pulls the Workers
// runtime deps, e.g. @cloudflare/containers, which don't resolve here) — the same reason the path
// was extracted — so this pins the wiring the way the repo's own application-architecture.test.ts
// does: by asserting the composition in the source. If a refactor inlined the grant path or dropped
// the guarded service, this fails.
test("the native-VNC route delegates to the guarded NativeVNCService (production wiring)", async () => {
  const worker = await readFile(
    new URL("../src/worker/worker-application.ts", import.meta.url),
    "utf8",
  );
  // createNativeVNCGrant is wired through NativeVNCService, not minting inline.
  assert.match(
    worker,
    /createNativeVNCGrant:\s*\(user, sessionId\)\s*=>\s*\n?\s*new NativeVNCService\(/,
    "the native route must construct NativeVNCService",
  );
  // its readSession/mintGrant deps are the real production seams.
  assert.match(worker, /readSession:\s*\(u, id\)\s*=>\s*this\.sessions\.readVisibleFresh\(u, id\)/);
  assert.match(
    worker,
    /mintGrant:[\s\S]*?this\.runtime[\s\S]*?\.workspaceLifecycle\(\)[\s\S]*?\.createNativeVNCGrant\(/,
  );
  // the pre-fix inline mint (workspaceLifecycle().createNativeVNCGrant reached straight from the
  // route, with no NativeVNCService between) must be gone.
  assert.doesNotMatch(
    worker,
    /return await this\.runtime\s*\n?\s*\.workspaceLifecycle\(\)\s*\n?\s*\.createNativeVNCGrant\(/,
    "the native route must not mint inline (bypassing the status guard)",
  );
});
