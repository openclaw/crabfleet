import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/codeql.yml", import.meta.url),
  "utf8",
);

test("CodeQL covers every first-party language with its required build mode", () => {
  assert.match(workflow, /- actions\s+- javascript-typescript/);
  assert.match(workflow, /languages: go\s+build-mode: manual/);
  assert.match(workflow, /run: go build \.\/\.\.\./);
  assert.doesNotMatch(workflow, /github\/codeql-action\/autobuild@/);
  assert.match(workflow, /languages: swift\s+build-mode: manual/);
  assert.match(
    workflow,
    /swift build\s+--package-path macos\/CrabfleetMac\s+--scratch-path "\$RUNNER_TEMP\/crabfleet-codeql-swift"\s+--arch arm64/,
  );
});

test("CodeQL uses pinned actions and least-privilege checkout", () => {
  assert.match(workflow, /permissions:\s+contents: read\s+security-events: write/);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.equal(
    workflow.match(/actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\s+persist-credentials: false/g)
      ?.length,
    3,
  );
  assert.equal(
    workflow.match(/github\/codeql-action\/(?:init|analyze)@[0-9a-f]{40}(?=\s|$)/g)?.length,
    6,
  );
  assert.match(
    workflow,
    /actions\/setup-go@[0-9a-f]{40}[^\n]*\n\s+with:\s+go-version: "1\.27\.3"\s+go-version-file: go\.mod\s+cache-dependency-path: go\.sum/,
  );
  assert.doesNotMatch(workflow, /uses:\s+[^@\s]+@(?![0-9a-f]{40}(?:\s|$))/);
});

test("CodeQL analyzes pull requests, weekly main, and manual runs", () => {
  assert.match(workflow, /^on:$/m);
  assert.match(workflow, /pull_request:\s+branches:\s+- main/);
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.match(workflow, /schedule:\s+- cron: "49 4 \* \* 1"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(
    workflow,
    /group: codeql-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name \}\}/,
  );
  assert.match(
    workflow,
    /github\.event_name == 'workflow_dispatch' && github\.run_id \|\| github\.event\.pull_request\.number \|\| github\.ref/,
  );
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});
