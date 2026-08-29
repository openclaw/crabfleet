import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/codeql.yml", import.meta.url),
  "utf8",
);

test("CodeQL covers every first-party language with its required build mode", () => {
  assert.match(workflow, /- actions\s+- javascript-typescript/);
  assert.match(workflow, /languages: go\s+build-mode: autobuild/);
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
    workflow.match(
      /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1\s+with:\s+persist-credentials: false/g,
    )?.length,
    3,
  );
  assert.equal(
    workflow.match(
      /github\/codeql-action\/(?:init|analyze)@cdf488f595d80d6e07e03d4674febd5ab45fa938 # v4\.37\.9/g,
    )?.length,
    6,
  );
  assert.match(
    workflow,
    /actions\/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7\.0\.0\s+with:\s+go-version-file: go\.mod\s+cache-dependency-path: go\.sum/,
  );
  assert.doesNotMatch(workflow, /uses:\s+[^@\s]+@(?![0-9a-f]{40}(?:\s|$))/);
});

test("CodeQL analyzes pull requests, main, schedules, and manual runs", () => {
  assert.match(workflow, /^on:$/m);
  assert.match(workflow, /pull_request:\s+branches:\s+- main/);
  assert.match(workflow, /push:\s+branches:\s+- main/);
  assert.match(workflow, /schedule:\s+- cron:/);
  assert.match(workflow, /workflow_dispatch:/);
});
