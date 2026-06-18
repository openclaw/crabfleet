import type { User } from "./models.ts";
import { badRequest, forbidden, notFound } from "./http.ts";
import { canControlInteractiveSession, canManageInteractiveSession } from "./session-access.ts";
import type { SandboxCheckpoint } from "./session-control-do.ts";
import {
  isSandboxInteractiveSession,
  sandboxIdForSession,
  sandboxLeaseInfo,
} from "./sandbox-lease.ts";
import type { InteractiveSession } from "./session-model.ts";

type DiagnosticsResult = {
  success: boolean;
  stdout: string;
  stderr: string;
};

export type SandboxSessionResourceServiceDependencies = {
  now(): number;
  sandboxAvailable: boolean;
  readSession(sessionId: string): Promise<InteractiveSession | null>;
  presentSession(session: InteractiveSession, user: User): InteractiveSession;
  delegatedControlAvailable(session: InteractiveSession): boolean;
  runDiagnostics(
    session: InteractiveSession,
    workdir: string,
    script: string,
  ): Promise<DiagnosticsResult>;
  listStoredCheckpoints(sessionId: string): Promise<SandboxCheckpoint[]>;
  storeCheckpoint(checkpoint: SandboxCheckpoint): Promise<void>;
  readStoredCheckpoint(sessionId: string, checkpointId: string): Promise<SandboxCheckpoint | null>;
  createBackup(
    session: InteractiveSession,
    workdir: string,
    name: string,
  ): Promise<SandboxCheckpoint["backup"]>;
  restoreBackup(session: InteractiveSession, backup: SandboxCheckpoint["backup"]): Promise<void>;
  appendEvent(sessionId: string, user: User, message: string, now: number): Promise<void>;
};

export class SandboxSessionResourceService {
  private readonly dependencies: SandboxSessionResourceServiceDependencies;

  constructor(dependencies: SandboxSessionResourceServiceDependencies) {
    this.dependencies = dependencies;
  }

  async readDiagnostics(
    user: User,
    sessionId: string,
  ): Promise<{ session: InteractiveSession; diagnostics: unknown }> {
    const session = await this.readSession(sessionId);
    const presented = this.dependencies.presentSession(session, user);
    if (
      !canControlInteractiveSession(
        user,
        session,
        this.dependencies.now(),
        this.dependencies.delegatedControlAvailable(session),
      )
    ) {
      throw forbidden("terminal control has not been granted");
    }
    if (!this.dependencies.sandboxAvailable || !isSandboxInteractiveSession(session)) {
      return {
        session: presented,
        diagnostics: {
          available: false,
          reason: "diagnostics are only available for Cloudflare Sandbox sessions",
        },
      };
    }

    const result = await this.dependencies.runDiagnostics(
      session,
      sandboxWorkdir(session.id),
      sandboxDiagnosticsScript,
    );
    if (!result.success) {
      return {
        session: presented,
        diagnostics: {
          available: false,
          reason: clean(result.stderr || result.stdout || "diagnostics failed", 700),
        },
      };
    }
    const output = result.stdout.trim();
    try {
      return { session: presented, diagnostics: JSON.parse(output) };
    } catch {
      return {
        session: presented,
        diagnostics: {
          available: false,
          reason: "diagnostics returned invalid JSON",
          output: clean(output, 700),
        },
      };
    }
  }

  async listCheckpoints(
    user: User,
    sessionId: string,
  ): Promise<{
    checkpoints: Array<Omit<SandboxCheckpoint, "backup">>;
    session: InteractiveSession;
  }> {
    const session = await this.managedSession(user, sessionId);
    const checkpoints = await this.dependencies.listStoredCheckpoints(sessionId);
    return {
      checkpoints: checkpoints.map(withoutBackup),
      session: this.dependencies.presentSession(session, user),
    };
  }

  async createCheckpoint(
    user: User,
    sessionId: string,
  ): Promise<{ checkpoint: Omit<SandboxCheckpoint, "backup">; session: InteractiveSession }> {
    const session = await this.managedSession(user, sessionId);
    const lease = sandboxLeaseInfo(session);
    const workdir = sandboxWorkdir(sessionId);
    const now = this.dependencies.now();
    const name = `checkpoint-${now}`;
    const backup = await this.dependencies.createBackup(session, workdir, name);
    const checkpoint: SandboxCheckpoint = {
      backup,
      createdAt: now,
      id: backup.id,
      name,
      sessionId,
      workdir,
    };
    await this.dependencies.storeCheckpoint(checkpoint);
    await this.dependencies.appendEvent(
      sessionId,
      user,
      `checkpoint created ${checkpoint.id} in ${lease.sandboxId}`,
      this.dependencies.now(),
    );
    return {
      checkpoint: withoutBackup(checkpoint),
      session: this.dependencies.presentSession(session, user),
    };
  }

  async restoreCheckpoint(
    user: User,
    sessionId: string,
    checkpointId: string,
  ): Promise<{ checkpoint: Omit<SandboxCheckpoint, "backup">; session: InteractiveSession }> {
    const session = await this.managedSession(user, sessionId);
    const checkpoint = await this.dependencies.readStoredCheckpoint(sessionId, checkpointId);
    if (!checkpoint) throw notFound("checkpoint not found");
    await this.dependencies.restoreBackup(session, checkpoint.backup);
    await this.dependencies.appendEvent(
      sessionId,
      user,
      `checkpoint restored ${checkpoint.id}`,
      this.dependencies.now(),
    );
    return {
      checkpoint: withoutBackup(checkpoint),
      session: this.dependencies.presentSession(session, user),
    };
  }

  private async readSession(sessionId: string): Promise<InteractiveSession> {
    const session = await this.dependencies.readSession(sessionId);
    if (!session) throw notFound("interactive session not found");
    return session;
  }

  private async managedSession(user: User, sessionId: string): Promise<InteractiveSession> {
    const session = await this.readSession(sessionId);
    if (!canManageInteractiveSession(user, session)) {
      throw forbidden("only the session owner or maintainer can manage checkpoints");
    }
    if (!this.dependencies.sandboxAvailable || !isSandboxInteractiveSession(session)) {
      throw badRequest("checkpoints require a Cloudflare Sandbox session");
    }
    if (["stopping", "expired", "failed", "stopped"].includes(session.status)) {
      throw badRequest(`session is ${session.status}`);
    }
    return session;
  }
}

function withoutBackup(checkpoint: SandboxCheckpoint): Omit<SandboxCheckpoint, "backup"> {
  const { backup: _backup, ...visible } = checkpoint;
  return visible;
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}

const sandboxDiagnosticsScript = `
node - <<'NODE'
const fs = require("fs");
const cp = require("child_process");
const tools = [
  "bash", "git", "gh", "node", "npm", "pnpm", "codex", "rg", "fd", "jq",
  "python3", "pip3", "make", "gcc", "time", "ssh", "rsync", "curl",
  "unzip", "zip", "sqlite3", "shellcheck", "crabbox"
];
const workdir = process.env.CRABBOX_WORKDIR || "";
const repo = process.env.CRABBOX_REPO || "";
const home = process.env.HOME || "/root";
function run(command, args) {
  try {
    return cp.execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000
    }).trim();
  } catch {
    return "";
  }
}
function shell(command) {
  return run("/bin/bash", ["-lc", command]);
}
function which(tool) {
  return shell("command -v " + JSON.stringify(tool));
}
function oneLine(text) {
  return String(text || "").split(/\\r?\\n/).find(Boolean) || "";
}
const toolResults = tools.map((name) => {
  const path = which(name);
  return {
    name,
    present: Boolean(path),
    path: path || null,
    version: path ? oneLine(run(path, ["--version"])) || null : null
  };
});
const missing = toolResults.filter((tool) => !tool.present).map((tool) => tool.name);
const checkout = {
  path: workdir,
  exists: Boolean(workdir && fs.existsSync(workdir)),
  git: Boolean(workdir && fs.existsSync(workdir + "/.git")),
  branch: workdir ? run("git", ["-C", workdir, "rev-parse", "--abbrev-ref", "HEAD"]) || null : null,
  head: workdir ? run("git", ["-C", workdir, "rev-parse", "--short", "HEAD"]) || null : null,
  remote: workdir ? run("git", ["-C", workdir, "config", "--get", "remote.origin.url"]).replace(/\\/\\/[^/@]+@/g, "//<redacted>@") || null : null
};
const codexHome = process.env.CODEX_HOME || home + "/.codex";
const repoPermissionsRaw = repo ? run("gh", ["api", "repos/" + repo, "--jq", ".permissions"]) : "";
let repoPermissions = null;
try {
  repoPermissions = repoPermissionsRaw ? JSON.parse(repoPermissionsRaw) : null;
} catch {}
const diagnostics = {
  available: true,
  imageVersion: process.env.CRABBOX_IMAGE_VERSION || null,
  cwd: process.cwd(),
  checkout,
  github: {
    credentialProxy: process.env.CRABFLEET_SANDBOX === "1",
    credentialFilePresent: fs.existsSync(home + "/.config/crabbox/github-credential"),
    ghAuthenticated: Boolean(run("gh", ["api", "user", "--jq", ".login"])),
    repo,
    permissions: repoPermissions
  },
  codex: {
    home: codexHome,
    configPresent: fs.existsSync(codexHome + "/config.toml"),
    authPresent: fs.existsSync(codexHome + "/auth.json")
  },
  tools: toolResults,
  missing
};
console.log(JSON.stringify(diagnostics));
NODE
`;

function sandboxWorkdir(sessionId: string): string {
  return `/workspace/${sandboxIdForSession(sessionId)}`;
}
