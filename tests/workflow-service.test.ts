import assert from "node:assert/strict";
import test from "node:test";

import type { RepoWorkflow } from "../src/worker/workflow-model.ts";
import type { WorkflowRepositoryStore } from "../src/worker/workflow-repository.ts";
import {
  parseWorkflowMarkdown,
  WorkflowService,
  type WorkflowServiceDependencies,
} from "../src/worker/workflow-service.ts";

function workflow(values: Partial<RepoWorkflow> = {}): RepoWorkflow {
  return {
    repo: "openclaw/crabfleet",
    status: "ok",
    sourcePath: "CRABBOX.md",
    sourceSha: "sha-1",
    config: { runtime: "container" },
    prompt: "Do the work",
    error: null,
    evaluatedAt: 100,
    updatedAt: 100,
    ...values,
  };
}

function dependencies(
  calls: string[],
  existing: RepoWorkflow | null = null,
): WorkflowServiceDependencies {
  const repository: WorkflowRepositoryStore = {
    async read(repo) {
      calls.push(`read:${repo}`);
      return existing;
    },
    async summaries() {
      calls.push("summaries");
      return existing ? [existing] : [];
    },
    async write(value) {
      calls.push(`write:${value.status}:${value.sourceSha}:${value.error}`);
      return value;
    },
  };
  return {
    repository,
    cacheMs: 1_000,
    async fetchSource(repo) {
      calls.push(`fetch:${repo}`);
      return new Response(null, { status: 404 });
    },
  };
}

test("workflow parser normalizes nested frontmatter and reports invalid fields", () => {
  assert.deepEqual(
    parseWorkflowMarkdown(`---
runtime:
  default: crabbox
merge:
  policy: merge_when_green
stall_ms: 120000
cap: 4
prompt_prefix: Review carefully
---
Run the task`),
    {
      config: {
        runtime: "crabbox",
        policy: "merge_when_green",
        stallMs: 120000,
        cap: 4,
        promptPrefix: "Review carefully",
      },
      prompt: "Run the task",
      error: null,
    },
  );

  const invalid = parseWorkflowMarkdown(`---
runtime: invalid
cap: zero
---
Run`);
  assert.deepEqual(invalid.config, {});
  assert.match(invalid.error ?? "", /unsupported runtime invalid/);
  assert.match(invalid.error ?? "", /invalid cap zero/);

  const bounded = parseWorkflowMarkdown(`---
prompt:
  prefix: "  ${"x".repeat(1_100)}  "
---
Run`);
  assert.equal(bounded.config.promptPrefix, "x".repeat(1_000));
});

test("workflow ensure returns a fresh cache entry without transport", async () => {
  const calls: string[] = [];
  const existing = workflow({ evaluatedAt: 900 });
  const result = await new WorkflowService(dependencies(calls, existing)).ensure(
    existing.repo,
    1_000,
  );

  assert.equal(result, existing);
  assert.deepEqual(calls, ["read:openclaw/crabfleet"]);
});

test("workflow ensure retains stale cache when refresh transport fails", async () => {
  const calls: string[] = [];
  const existing = workflow({ evaluatedAt: 0 });
  const serviceDependencies = dependencies(calls, existing);
  serviceDependencies.fetchSource = async (repo) => {
    calls.push(`fetch:${repo}`);
    throw new Error("network unavailable");
  };
  const result = await new WorkflowService(serviceDependencies).ensure(existing.repo, 2_000);

  assert.equal(result, existing);
  assert.deepEqual(calls, ["read:openclaw/crabfleet", "fetch:openclaw/crabfleet"]);
});

test("workflow refresh persists missing and invalid source states", async () => {
  const missingCalls: string[] = [];
  const missing = await new WorkflowService(dependencies(missingCalls)).refresh(
    "openclaw/crabfleet",
    200,
  );
  assert.equal(missing.status, "missing");
  assert.deepEqual(missingCalls, [
    "fetch:openclaw/crabfleet",
    "write:missing:null:CRABBOX.md not found",
  ]);

  const invalidCalls: string[] = [];
  const invalidDependencies = dependencies(invalidCalls);
  invalidDependencies.fetchSource = async (repo) => {
    invalidCalls.push(`fetch:${repo}`);
    return Response.json({ encoding: "utf-8", content: "text", sha: "sha-invalid" });
  };
  const invalid = await new WorkflowService(invalidDependencies).refresh("openclaw/crabfleet", 300);
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.sourceSha, "sha-invalid");
  assert.deepEqual(invalidCalls, [
    "fetch:openclaw/crabfleet",
    "write:invalid:sha-invalid:unsupported CRABBOX.md encoding",
  ]);
});

test("workflow refresh decodes and persists valid source", async () => {
  const calls: string[] = [];
  const serviceDependencies = dependencies(calls);
  const markdown = `---
runtime: container
policy: open_pr
---
Investigate`;
  serviceDependencies.fetchSource = async (repo) => {
    calls.push(`fetch:${repo}`);
    return Response.json({
      encoding: "base64",
      content: btoa(markdown),
      sha: "sha-valid",
    });
  };
  const result = await new WorkflowService(serviceDependencies).refresh("openclaw/crabfleet", 400);

  assert.equal(result.status, "ok");
  assert.deepEqual(result.config, { runtime: "container", policy: "open_pr" });
  assert.equal(result.prompt, "Investigate");
  assert.deepEqual(calls, ["fetch:openclaw/crabfleet", "write:ok:sha-valid:null"]);
});
