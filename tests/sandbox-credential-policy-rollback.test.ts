import assert from "node:assert/strict";
import test from "node:test";

import { credentialPolicyRegistrationAccepted } from "../src/credential-policy-fence.ts";
import {
  captureSandboxCredentialPolicyRollback,
  restoreSandboxCredentialPolicyRollback,
} from "../src/worker/sandbox-credential-policy-rollback.ts";
import type {
  SandboxCredentialPolicyRegistration,
  StoredSandboxCredentialPolicy,
} from "../src/worker/session-control-policy.ts";

function storedPolicy(
  lookupId: string,
  generation: string,
  claim: string,
  registrationExpiresAt: number,
): StoredSandboxCredentialPolicy {
  return {
    generation,
    registrationClaim: claim,
    registrationExpiresAt,
    policy: {
      allowedHosts: [],
      githubCredentialSource: "none",
      githubRepo: "openclaw/crabfleet",
      owner: "operator",
      sandboxId: lookupId,
      sessionId: "IS-42",
    },
  };
}

function policyStub(policies: Map<string, StoredSandboxCredentialPolicy>) {
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = new URL(String(input));
      const egress = url.pathname.match(/^\/api\/session-control\/egress\/([^/]+)$/);
      if (egress && (!init?.method || init.method === "GET")) {
        const current = policies.get(decodeURIComponent(egress[1] ?? ""));
        return current
          ? Response.json(current.policy, {
              headers: { "x-crabfleet-policy-generation": current.generation },
            })
          : Response.json({ error: "not found" }, { status: 404 });
      }
      if (url.pathname === "/api/session-control/register" && init?.method === "POST") {
        const incoming = JSON.parse(String(init.body)) as StoredSandboxCredentialPolicy;
        const current = policies.get(incoming.policy.sandboxId);
        if (!credentialPolicyRegistrationAccepted(current, undefined, incoming, Date.now())) {
          return Response.json({ error: "conflict" }, { status: 409 });
        }
        policies.set(incoming.policy.sandboxId, incoming);
        return Response.json({ ok: true });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  };
}

test("partial policy generation writes restore every prior live lookup", async () => {
  const now = Date.now();
  const lookupIds = ["sandbox-1", "do-1"];
  const policies = new Map(
    lookupIds.map((lookupId) => [
      lookupId,
      storedPolicy(lookupId, "generation:prior", "registration:prior", now + 1_000),
    ]),
  );
  const stub = policyStub(policies);
  const rollback = await captureSandboxCredentialPolicyRollback(
    stub,
    lookupIds,
    "generation:prior",
    "IS-42",
  );
  const registration: SandboxCredentialPolicyRegistration = {
    generation: "generation:replacement",
    claim: "registration:replacement",
    lookupIds,
  };
  const replacementExpiresAt = now + 60_000;

  policies.set(
    "sandbox-1",
    storedPolicy("sandbox-1", registration.generation, registration.claim, replacementExpiresAt),
  );
  await restoreSandboxCredentialPolicyRollback(
    stub,
    registration,
    replacementExpiresAt,
    JSON.stringify(rollback),
    "IS-42",
  );

  for (const current of policies.values()) {
    assert.equal(current.generation, "generation:prior");
    assert.match(current.registrationClaim, /^rollback:registration:replacement$/);
    assert.ok(current.registrationExpiresAt > replacementExpiresAt);
  }
});

test("rollback snapshots reject incomplete prior generations before replacement", async () => {
  const policies = new Map([
    [
      "sandbox-1",
      storedPolicy("sandbox-1", "generation:prior", "registration:prior", Date.now() + 1_000),
    ],
  ]);

  await assert.rejects(
    captureSandboxCredentialPolicyRollback(
      policyStub(policies),
      ["sandbox-1", "do-1"],
      "generation:prior",
      "IS-42",
    ),
    /rollback generation is incomplete/,
  );
});
