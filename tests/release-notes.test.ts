import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/release-notes.mjs", import.meta.url));

function extract(tag: string, changelog: string) {
  const directory = mkdtempSync(join(tmpdir(), "crabfleet-release-notes-"));
  try {
    const file = join(directory, "CHANGELOG.md");
    writeFileSync(file, changelog);
    return spawnSync(process.execPath, [script, tag, file], { encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("release notes preserve the exact selected section and contributor credit", () => {
  const section =
    "## 0.4.0 - 2026-09-24\n\n**Highlights:** Desktop sharing.\n\n- Fix input, thanks @reporter (#12).\n";
  const result = extract(
    "v0.4.0",
    `# Changelog\n\n## Unreleased\n\n- Pending work.\n\n${section}\n## 0.3.1 - 2026-08-28\n\n- Older work.\n`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, section);
});

test("release notes support a final section and prerelease tags", () => {
  for (const version of ["0.4.0-rc.1", "0.4.0-preview-linux", "0.4.0-preview-linux.1"]) {
    const section = `## ${version} - 2026-09-24\n\n- Preview.\n`;
    const result = extract(`v${version}`, `# Changelog\n\n${section}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, section);
  }
});

test("release notes reject missing, empty, duplicate, and malformed release targets", () => {
  for (const [tag, changelog] of [
    ["v0.4.0", "# Changelog\n\n## 0.4.01 - 2026-09-24\n\n- Wrong release.\n"],
    ["v0.4.0", "## 0.4.0 - 2026-09-24\n\n## 0.3.1 - 2026-08-28\n\n- Older work.\n"],
    ["v0.4.0", "## 0.4.0 - 2026-09-24\n\n- One.\n\n## 0.4.0 - 2026-09-24\n\n- Two.\n"],
    ["main", "## main - 2026-09-24\n\n- Not a release.\n"],
  ]) {
    const result = extract(tag!, changelog!);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  }
});
