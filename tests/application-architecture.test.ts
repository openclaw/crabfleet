import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("worker entrypoint delegates interactive-session lifecycle composition", async () => {
  const [entrypoint, worker, application] = await Promise.all([
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/worker/worker-application.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/worker/interactive-session-application.ts", import.meta.url), "utf8"),
  ]);

  assert.match(entrypoint, /new WorkerApplication\(/);
  assert.doesNotMatch(entrypoint, /new InteractiveSessionApplication\(/);
  assert.match(worker, /new InteractiveSessionApplication\(/);
  assert.match(worker, /this\.sessions\.create\(/);
  assert.match(worker, /this\.sessions\.mutate\(/);
  assert.match(worker, /this\.sessions\.readFreshForUser\(/);
  assert.doesNotMatch(entrypoint, /InteractiveSession(?:Creation|Attach|Metadata|Stop)Service/);

  assert.match(application, /export class InteractiveSessionApplication/);
  assert.match(application, /new InteractiveSessionCreationService\(/);
  assert.match(application, /new InteractiveSessionAttachService\(/);
  assert.match(application, /new InteractiveSessionMetadataService\(/);
  assert.match(application, /new InteractiveSessionStopService\(/);
});

test("worker entrypoint delegates OpenClaw and GitHub Actions composition", async () => {
  const [entrypoint, worker, openClaw, githubActions] = await Promise.all([
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/worker/worker-application.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/worker/openclaw-application.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/worker/github-actions-application.ts", import.meta.url), "utf8"),
  ]);

  assert.match(worker, /new OpenClawApplication\(/);
  assert.match(worker, /new GitHubActionsApplication\(/);
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
  assert.match(openClaw, /mutate\([\s\S]*?openClawAuthorizedUser/);
  assert.match(openClaw, /openTerminal\([\s\S]*?openClawAuthorizedUser/);
  assert.match(openClaw, /decorateSession:[\s\S]*?openClawAuthorizedUser/);
  assert.match(
    openClaw,
    /createSession: async[\s\S]*?requireRootScopedSession[\s\S]*?openClawAuthorizedUser/,
  );
  assert.match(githubActions, /export class GitHubActionsApplication/);
  assert.match(githubActions, /new GitHubActionsSessionRegistrationService\(/);
  assert.match(githubActions, /new GitHubActionsWorkStateService\(/);
});

test("worker entrypoint retains only routing and platform composition", async () => {
  const entrypoint = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

  assert.doesNotMatch(entrypoint, /new (?:Admin|Card|Ssh|InteractiveTerminal)/);
  assert.doesNotMatch(entrypoint, /function (?:readState|readFleetState|workerApplication)/);
  assert.match(entrypoint, /application\.controlPlaneRoutes\(context\)/);
  assert.match(entrypoint, /application\.serviceSessionRoutes\(\)/);
  assert.match(entrypoint, /application\.browserSessionRoutes\(\)/);
});

test("terminal subscriptions authorize around targeted lifecycle refresh", async () => {
  const terminal = await readFile(
    new URL("../src/worker/interactive-terminal-service.ts", import.meta.url),
    "utf8",
  );
  assert.match(terminal, /readAuthorizedFreshSession\(\{/);
  assert.match(terminal, /authorize: \(session\) =>[\s\S]*canViewTerminalSession/);
  assert.match(terminal, /refresh: async \(\) =>[\s\S]*reconcileSession/);
});

test("authorized transcript responses are never stored in shared caches", async () => {
  const application = await readFile(
    new URL("../src/worker/interactive-session-application.ts", import.meta.url),
    "utf8",
  );
  const transcript = application.slice(
    application.indexOf("  async transcript("),
    application.indexOf("  async updateSummary("),
  );

  assert.match(transcript, /securityHeaders\("text\/markdown; charset=utf-8", false\)/);
  assert.match(transcript, /"cache-control": "no-store"/);
  assert.doesNotMatch(transcript, /securityHeaders\("text\/markdown; charset=utf-8"\)/);
});

test("session state applies the final active-grant authorization snapshot", async () => {
  const application = await readFile(
    new URL("../src/worker/interactive-session-application.ts", import.meta.url),
    "utf8",
  );
  const readAll = application.slice(
    application.indexOf("  async readAll("),
    application.indexOf("  async readFresh("),
  );

  assert.match(readAll, /readActiveForSessions/);
  assert.match(readAll, /flatMap/);
  assert.match(readAll, /this\.canView\(user, session, grant, now\)/);
});
