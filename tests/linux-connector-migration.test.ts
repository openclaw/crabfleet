import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createNativeAuthService,
  connectorAccessScope,
  nativeAccessScope,
} from "../src/worker/native-auth.ts";
import type { User } from "../src/worker/models.ts";
import { sqliteRuntimeEnv } from "./helpers/sqlite-env.ts";

function migrate(db: DatabaseSync, names: string[]) {
  for (const name of names)
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
}

test("connector grants persist their separate scope and renew only while authorized", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrate(db, [
      "0001_initial.sql",
      "0031_native_device_auth.sql",
      "0044_linux_connector_authorization.sql",
    ]);
    const env = Object.assign(sqliteRuntimeEnv(db), {
      CRABBOX_TOKEN_ENCRYPTION_KEY: "fixture-encryption-key",
      CRABFLEET_TRUSTED_PROXY_ORIGIN: "https://backend.example",
      CRABFLEET_TRUSTED_PROXY_PUBLIC_ORIGIN: "https://fleet.example",
      CRABFLEET_TRUSTED_PROXY_SECRET: "fixture-proxy-secret",
      CRABFLEET_TRUSTED_PROXY_AUTO_ROLE: "viewer",
      GITHUB_REDIRECT_URI: "https://fleet.example/auth/github/callback",
    });
    const user: User = {
      subject: "proxy:viewer@example.com",
      email: "viewer@example.com",
      login: null,
      name: "Fixture viewer",
      role: "viewer",
      allowed: true,
      teams: [],
    };
    db.prepare(
      "INSERT INTO users (subject,email,name,role,allowed,teams,created_at,updated_at,last_seen_at) VALUES (?,?,?,'viewer',1,'[]',1,1,1)",
    ).run(user.subject, user.email, user.name);
    const service = createNativeAuthService(env);
    for (const scope of [nativeAccessScope, connectorAccessScope]) {
      const device = await service.start("Fixture connector", "192.0.2.1", scope);
      const code = new URL(device.verificationUri).pathname.split("/").at(-1)!;
      assert.equal((await service.link(code)).scope, scope);
      await service.approve(code, user);
      const granted = await service.poll(device.deviceCode);
      assert.equal(granted.kind, "authorized");
      if (granted.kind !== "authorized") throw new Error("grant missing");
      const request = new Request("https://fleet.example/api/connector/v1/session", {
        headers: { authorization: `Bearer ${granted.accessToken}` },
      });
      assert.equal((await service.authenticate(request, scope)).subject, user.subject);
      if (scope === nativeAccessScope) {
        await assert.rejects(service.renewConnector(request));
      } else {
        await assert.rejects(service.authenticate(request));
        const renewed = await service.renewConnector(request);
        assert.ok(renewed.expiresAt >= granted.expiresAt);
        assert.equal(
          db.prepare("SELECT expires_at FROM native_access_tokens WHERE scope=?").get(scope)
            ?.expires_at,
          renewed.expiresAt,
        );
        await service.revoke(request);
        await assert.rejects(service.renewConnector(request));
      }
    }
  } finally {
    db.close();
  }
});

test("relay-only migration preserves old hosts and clears the capability on an older direct update", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrate(db, [
      "0030_desktop_hosts.sql",
      "0033_desktop_host_ownership.sql",
      "0038_desktop_host_publication_identity.sql",
      "0041_desktop_host_ownership_errors.sql",
      "0042_desktop_host_quic.sql",
    ]);
    db.exec(
      "INSERT INTO desktop_hosts (owner_subject,id,owner,name,address,port,created_at,updated_at) VALUES ('fixture','linux','fixture','Linux','100.64.1.2',5900,1,1)",
    );
    migrate(db, ["0045_desktop_host_relay_only.sql"]);
    assert.equal(db.prepare("SELECT relay_only FROM desktop_hosts").get()?.relay_only, 0);
    db.exec("UPDATE desktop_hosts SET relay_only=1,address='' WHERE id='linux'");
    assert.equal(db.prepare("SELECT relay_only FROM desktop_hosts").get()?.relay_only, 1);
    db.exec("UPDATE desktop_hosts SET address='100.64.1.2' WHERE id='linux'");
    assert.equal(db.prepare("SELECT relay_only FROM desktop_hosts").get()?.relay_only, 0);
    assert.throws(() => db.exec("UPDATE desktop_hosts SET relay_only=2"), /constraint/i);
  } finally {
    db.close();
  }
});
