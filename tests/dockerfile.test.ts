import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Crabbox image pins the default release and requires pinned version overrides", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");

  assert.match(
    dockerfile,
    /pinned_checksum="3c41839257e4622e28bcec8b0f0153f19d78d436fd548894a7c7d7726d922611"/,
  );
  assert.match(
    dockerfile,
    /pinned_checksum="4bf87a0d2365441ee2f8cb34183cfd9ebeb065111697eb2d8dc867b3a627fdd2"/,
  );
  assert.doesNotMatch(dockerfile, /checksums\.txt/);
  assert.match(dockerfile, /an explicit \$checksum_arg is required/);
  assert.match(dockerfile, /grep -Eq '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(dockerfile, /sha256sum -c -/);
});
