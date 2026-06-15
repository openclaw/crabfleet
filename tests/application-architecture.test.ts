import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("worker entrypoint delegates interactive-session lifecycle composition", async () => {
  const [entrypoint, application] = await Promise.all([
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/worker/interactive-session-application.ts", import.meta.url), "utf8"),
  ]);

  assert.match(entrypoint, /new InteractiveSessionApplication\(/);
  assert.match(entrypoint, /sessions\.create\(/);
  assert.match(entrypoint, /sessions\.mutate\(/);
  assert.match(entrypoint, /sessions\.readFresh\(/);
  assert.doesNotMatch(entrypoint, /InteractiveSession(?:Creation|Attach|Metadata|Stop)Service/);

  assert.match(application, /export class InteractiveSessionApplication/);
  assert.match(application, /new InteractiveSessionCreationService\(/);
  assert.match(application, /new InteractiveSessionAttachService\(/);
  assert.match(application, /new InteractiveSessionMetadataService\(/);
  assert.match(application, /new InteractiveSessionStopService\(/);
});

test("worker entrypoint delegates OpenClaw and GitHub Actions composition", async () => {
  const [entrypoint, openClaw, githubActions] = await Promise.all([
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/worker/openclaw-application.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/worker/github-actions-application.ts", import.meta.url), "utf8"),
  ]);

  assert.match(entrypoint, /new OpenClawApplication\(/);
  assert.match(entrypoint, /new GitHubActionsApplication\(/);
  assert.match(entrypoint, /application\.openClaw\.controller\(\)/);
  assert.doesNotMatch(
    entrypoint,
    /OpenClaw(?:Controller|CreateService|MutationService|RootStopService|SupervisionService)/,
  );
  assert.doesNotMatch(
    entrypoint,
    /GitHubActions(?:SessionRegistrationService|WorkStateService|RunnerConnectionService)/,
  );

  assert.match(openClaw, /export class OpenClawApplication/);
  assert.match(openClaw, /new OpenClawController\(/);
  assert.match(openClaw, /new OpenClawSupervisionService\(/);
  assert.match(githubActions, /export class GitHubActionsApplication/);
  assert.match(githubActions, /new GitHubActionsSessionRegistrationService\(/);
  assert.match(githubActions, /new GitHubActionsWorkStateService\(/);
});
