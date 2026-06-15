import type { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";

import { sandboxGitAuthorEmail } from "../git-identity.ts";
import { deploymentConfig } from "./deployment.ts";
import type { RuntimeEnv } from "./env.ts";
import type { InteractiveProvisionRequest } from "./provisioning/types.ts";
import { sandboxIdForSession, sandboxLeaseInfo } from "./sandbox-lease.ts";
import { sandboxPlaceholderGitHubToken, sandboxPlaceholderOpenAIKey } from "./sandbox-outbound.ts";
import {
  isSandboxSessionAlreadyExists,
  isSandboxSessionAlreadyGone,
} from "./sandbox-session-errors.ts";
import type { InteractiveSession } from "./session-model.ts";

export type SandboxExecutionSession = Awaited<ReturnType<CloudflareSandbox["createSession"]>>;
export type SandboxSessionTarget = Pick<SandboxExecutionSession, "exec" | "mkdir" | "setEnvVars">;
export type SandboxRuntimeSession = (InteractiveProvisionRequest | InteractiveSession) & {
  githubToken?: string;
};

export function sandboxSetupSessionId(id: string): string {
  return clean(`setup-${id}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-"), 80);
}

export function sandboxWorkdir(id: string): string {
  return `/workspace/${sandboxIdForSession(id)}`;
}

export function sandboxAutostartScriptPath(id: string): string {
  return `/tmp/.crabbox-autostart-${sandboxIdForSession(id)}.sh`;
}

export function sandboxTerminalShellPath(id: string): string {
  return `/tmp/.crabbox-terminal-${sandboxIdForSession(id)}.sh`;
}

export function sandboxCheckoutErrorPath(id: string): string {
  return `/tmp/crabbox-checkout-error-${sandboxIdForSession(id)}.txt`;
}

export function sandboxBashrcMarker(
  session: Pick<InteractiveSession | InteractiveProvisionRequest, "id">,
): string {
  return `# crabbox session ${session.id} autostart-v4`;
}

export function terminalSize(request: Request, name: "cols" | "rows", fallback: number): number {
  const url = new URL(request.url);
  const value = Number(url.searchParams.get(name));
  if (!Number.isFinite(value)) return fallback;
  return Math.min(300, Math.max(10, Math.trunc(value)));
}

export async function createSandboxSession(
  sandbox: CloudflareSandbox,
  id: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<SandboxExecutionSession> {
  try {
    return await createNewSandboxSession(sandbox, id, cwd, env);
  } catch (error) {
    if (!isSandboxSessionAlreadyExists(error, id)) throw error;
    return sandbox.getSession(id);
  }
}

export async function createFreshSandboxSession(
  sandbox: CloudflareSandbox,
  id: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<SandboxExecutionSession> {
  try {
    await sandbox.deleteSession(id);
  } catch (error) {
    if (!isSandboxSessionAlreadyGone(error, id)) throw error;
  }
  try {
    return await createNewSandboxSession(sandbox, id, cwd, env);
  } catch (error) {
    if (!isSandboxSessionAlreadyExists(error, id)) throw error;
    throw new Error(`fresh sandbox session ${id} still exists after delete`, { cause: error });
  }
}

export async function runSandboxSetupStep(
  step: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = clean(error instanceof Error ? error.message : String(error), 500);
    throw new Error(`${step}: ${message || "failed"}`);
  }
}

export async function setupSandboxTerminalSession(
  sandbox: CloudflareSandbox,
  env: RuntimeEnv,
  session: SandboxRuntimeSession,
  workdir: string,
  terminalSessionId: string,
  agentToken?: string,
): Promise<void> {
  const sessionEnv = sandboxSessionEnv(env, session, agentToken);
  const setup = await createSandboxSession(
    sandbox,
    sandboxSetupSessionId(session.id),
    "/workspace",
    sessionEnv,
  );
  await runSandboxSetupStep("workspace mkdir", () => setup.mkdir(workdir, { recursive: true }));
  await runSandboxSetupStep("repository checkout", () =>
    prepareSandboxWorkspace(setup, session, workdir),
  );
  await runSandboxSetupStep("Codex auth", () => prepareSandboxCodexAuth(setup, env, workdir));
  await runSandboxSetupStep("runtime tools", () =>
    prepareSandboxRuntimeTools(setup, env, session, workdir, {}, agentToken),
  );
  await runSandboxSetupStep("terminal session", () =>
    createFreshSandboxSession(sandbox, terminalSessionId, workdir, sessionEnv),
  );
}

export async function openSandboxTerminalResponse(
  request: Request,
  env: RuntimeEnv,
  sandbox: CloudflareSandbox,
  session: InteractiveSession & { githubToken?: string },
  size: { cols: number; rows: number },
): Promise<Response> {
  const lease = sandboxLeaseInfo(session);
  const options = {
    cols: size.cols,
    rows: size.rows,
    shell: sandboxTerminalShellPath(session.id),
  };
  await ensureSandboxTerminalPrepared(sandbox, env, session, lease.terminalSessionId);
  const open = async () => {
    const terminalSession = await sandbox.getSession(lease.terminalSessionId);
    return terminalSession.terminal(request, options);
  };

  try {
    const response = await open();
    if (response.webSocket && response.status === 101) return response;
  } catch {
    // A previous PTY disconnect can leave the SDK execution session terminated.
  }

  await recreateSandboxTerminalSession(sandbox, env, session, lease.terminalSessionId);
  return open();
}

export function sandboxSessionEnv(
  env: RuntimeEnv,
  session: SandboxRuntimeSession,
  agentToken?: string,
): Record<string, string | undefined> {
  return {
    CRABBOX_SESSION_ID: session.id,
    CRABFLEET_SESSION_ID: session.id,
    CRABFLEET_PARENT_SESSION_ID: session.parentSessionId ?? undefined,
    CRABFLEET_ROOT_SESSION_ID: session.rootSessionId ?? session.id,
    CRABFLEET_AGENT_TOKEN: agentToken,
    CRABFLEET_API_URL: deploymentConfig(env).canonicalUrl,
    CRABBOX_REPO: session.repo,
    CRABBOX_BRANCH: session.branch,
    CRABBOX_RUNTIME: session.runtime,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    GH_TOKEN: sandboxHasGitHubCredential(env, session) ? sandboxPlaceholderGitHubToken : undefined,
    GITHUB_TOKEN: sandboxHasGitHubCredential(env, session)
      ? sandboxPlaceholderGitHubToken
      : undefined,
    TERM_PROGRAM: "ghostty",
    TERM_PROGRAM_VERSION: "web",
    OPENAI_API_KEY: env.OPENAI_API_KEY ? sandboxPlaceholderOpenAIKey : undefined,
    OPENAI_BASE_URL: env.OPENAI_BASE_URL,
    OPENAI_ORG_ID: env.OPENAI_ORG_ID,
  };
}

async function prepareSandboxWorkspace(
  sandbox: SandboxSessionTarget,
  session: SandboxRuntimeSession,
  workdir: string,
): Promise<void> {
  const repoUrl = `https://github.com/${session.repo}.git`;
  const quotedRepoUrl = shellQuote(repoUrl);
  const quotedBranch = shellQuote(session.branch);
  const quotedWorkdir = shellQuote(workdir);
  const quotedPrompt = shellQuote(session.prompt);
  const checkoutErrorPath = sandboxCheckoutErrorPath(session.id);
  const quotedCheckoutErrorPath = shellQuote(checkoutErrorPath);
  const resetResult = await sandbox.exec(
    [
      `if [ ! -d ${quotedWorkdir}/.git ]; then`,
      `  rm -rf ${quotedWorkdir}`,
      `  mkdir -p ${quotedWorkdir}`,
      `fi`,
      `rm -f ${quotedCheckoutErrorPath}`,
    ].join("\n"),
    { timeout: 30_000 },
  );
  if (!resetResult.success) {
    throw new Error(
      clean(resetResult.stderr || resetResult.stdout || "workspace reset failed", 500),
    );
  }

  const result = await sandbox.exec(
    [
      "checkout_status=0",
      "cat > /tmp/crabbox-git-askpass-placeholder.sh <<'EOF'",
      "#!/bin/sh",
      'case "$1" in',
      "  *Username*) printf '%s\\n' x-access-token ;;",
      `  *Password*) printf '%s\\n' ${shellQuote(sandboxPlaceholderGitHubToken)} ;;`,
      "  *) exit 1 ;;",
      "esac",
      "EOF",
      "chmod 700 /tmp/crabbox-git-askpass-placeholder.sh",
      "git_with_github_auth() {",
      `  GIT_TERMINAL_PROMPT=0 GIT_USERNAME=x-access-token GIT_PASSWORD=${shellQuote(
        sandboxPlaceholderGitHubToken,
      )} GIT_ASKPASS=${shellQuote("/tmp/crabbox-git-askpass-placeholder.sh")} git -c credential.helper= "$@"`,
      "}",
      `if [ ! -d ${quotedWorkdir}/.git ]; then`,
      `  tmp="${workdir}.clone.$$"`,
      `  rm -rf "$tmp"`,
      `  rm -f ${quotedCheckoutErrorPath}`,
      `  if git_with_github_auth clone --depth 1 --branch ${quotedBranch} ${quotedRepoUrl} "$tmp" 2>/tmp/crabbox-git-clone.log || git_with_github_auth clone --depth 1 ${quotedRepoUrl} "$tmp" 2>>/tmp/crabbox-git-clone.log; then`,
      `    if rm -rf ${quotedWorkdir} && mkdir -p ${quotedWorkdir} && cp -a "$tmp"/. ${quotedWorkdir}/; then`,
      `      :`,
      `    else`,
      `      checkout_status=$?`,
      `      printf 'Repository checkout copy failed for %s branch %s.\\n' ${quotedRepoUrl} ${quotedBranch} > ${quotedCheckoutErrorPath}`,
      `    fi`,
      `  else`,
      `    printf 'Repository checkout failed for %s branch %s. See /tmp/crabbox-git-clone.log.\\n' ${quotedRepoUrl} ${quotedBranch} > ${quotedCheckoutErrorPath}`,
      `    cat /tmp/crabbox-git-clone.log >> ${quotedCheckoutErrorPath} || true`,
      `    checkout_status=70`,
      `  fi`,
      `  rm -rf "$tmp"`,
      "fi",
      `if [ "$checkout_status" -eq 0 ] && [ ! -d ${quotedWorkdir}/.git ]; then`,
      `  if [ ! -s ${quotedCheckoutErrorPath} ]; then`,
      `    printf 'Repository checkout failed for %s branch %s.\\n' ${quotedRepoUrl} ${quotedBranch} > ${quotedCheckoutErrorPath}`,
      `  fi`,
      `  checkout_status=70`,
      `fi`,
      `if [ "$checkout_status" -eq 0 ]; then`,
      `  rm -f ${quotedCheckoutErrorPath}`,
      `  cd ${quotedWorkdir} || checkout_status=$?`,
      `fi`,
      `if [ "$checkout_status" -eq 0 ]; then git config --global --add safe.directory ${quotedWorkdir} || true; fi`,
      `if [ "$checkout_status" -eq 0 ]; then git remote set-url origin ${quotedRepoUrl} || true; fi`,
      `if [ "$checkout_status" -eq 0 ]; then git_with_github_auth fetch --depth 1 origin ${quotedBranch} || checkout_status=$?; fi`,
      `if [ "$checkout_status" -eq 0 ]; then git checkout -B ${quotedBranch} FETCH_HEAD || checkout_status=$?; fi`,
      `if [ "$checkout_status" -eq 0 ]; then git rev-parse --verify HEAD >/dev/null || checkout_status=$?; fi`,
      `if [ "$checkout_status" -eq 0 ]; then test "$(git rev-parse --abbrev-ref HEAD)" = ${quotedBranch} || checkout_status=$?; fi`,
      `if [ "$checkout_status" -eq 0 ]; then test "$(git config --get remote.origin.url)" = ${quotedRepoUrl} || checkout_status=$?; fi`,
      quotedPrompt
        ? `if [ "$checkout_status" -eq 0 ]; then printf '%s\n' ${quotedPrompt} > .crabbox-initial-prompt.txt || checkout_status=$?; fi`
        : `if [ "$checkout_status" -eq 0 ]; then rm -f .crabbox-initial-prompt.txt || checkout_status=$?; fi`,
      `if [ "$checkout_status" -eq 0 ]; then`,
      `  printf '\\nCRABBOX_CHECKOUT_OK\\n'`,
      `else`,
      `  if [ -s ${quotedCheckoutErrorPath} ]; then cat ${quotedCheckoutErrorPath}; fi`,
      `  printf '\\nCRABBOX_CHECKOUT_FAILED %s\\n' "$checkout_status"`,
      `fi`,
    ].join("\n"),
    { timeout: 120_000 },
  );
  const checkoutMarker = result.stdout.trim().split(/\r?\n/).at(-1);
  if (!result.success || checkoutMarker !== "CRABBOX_CHECKOUT_OK") {
    throw new Error(
      clean(
        [result.stdout, result.stderr].filter(Boolean).join("\n") || "repository checkout failed",
        700,
      ),
    );
  }
}

async function prepareSandboxCodexAuth(
  sandbox: SandboxSessionTarget,
  env: RuntimeEnv,
  workdir: string,
): Promise<void> {
  const projectKey = JSON.stringify(workdir);
  const workspaceKey = JSON.stringify("/workspace");
  const result = await sandbox.exec(
    `
set -eu
export CODEX_HOME="$HOME/.codex"
mkdir -p "$CODEX_HOME"
cat > "$CODEX_HOME/config.toml" <<'EOF'
cli_auth_credentials_store = "file"
forced_login_method = "api"
preferred_auth_method = "apikey"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[shell_environment_policy]
inherit = "all"
ignore_default_excludes = true

[features]
goals = true

[projects.${projectKey}]
trust_level = "trusted"

[projects.${workspaceKey}]
trust_level = "trusted"
EOF
if command -v node >/dev/null 2>&1; then
  node - <<'NODE'
const fs = require("fs");
const path = require("path");
const home = process.env.CODEX_HOME;
const apiKey = process.env.OPENAI_API_KEY || "";
if (!apiKey) process.exit(0);
fs.writeFileSync(
  path.join(home, "auth.json"),
  JSON.stringify({ OPENAI_API_KEY: apiKey, auth_mode: "apikey" }),
  { mode: 0o600 }
);
NODE
elif command -v codex >/dev/null 2>&1 && [ -n "\${OPENAI_API_KEY:-}" ]; then
  printf '%s' "$OPENAI_API_KEY" | codex -c 'forced_login_method="api"' login --with-api-key >/dev/null 2>&1 || true
fi
`,
    {
      timeout: 60_000,
      env: {
        OPENAI_API_KEY: env.OPENAI_API_KEY ? sandboxPlaceholderOpenAIKey : undefined,
        OPENAI_BASE_URL: env.OPENAI_BASE_URL,
        OPENAI_ORG_ID: env.OPENAI_ORG_ID,
      },
    },
  );
  if (!result.success) {
    throw new Error(clean(result.stderr || result.stdout || "Codex auth setup failed", 700));
  }
}

async function prepareSandboxRuntimeTools(
  sandbox: SandboxSessionTarget,
  env: RuntimeEnv,
  session: SandboxRuntimeSession,
  workdir: string,
  commandEnv: Record<string, string | undefined> = {},
  agentToken?: string,
): Promise<void> {
  const autostartScript = sandboxAutostartScriptPath(session.id);
  const terminalShell = sandboxTerminalShellPath(session.id);
  const result = await sandbox.exec(
    `
set -eu
export CODEX_HOME="$HOME/.codex"
missing_tools=""
for tool in git node npm pnpm codex gh rg fd jq python3 make gcc time ssh rsync crabbox; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    missing_tools="$missing_tools $tool"
  fi
done
if [ -n "$missing_tools" ]; then
  printf 'Crabfleet sandbox image is missing required tools:%s\\n' "$missing_tools" >/tmp/crabbox-runtime-tools.log
  if command -v crabbox-diagnostics >/dev/null 2>&1; then
    crabbox-diagnostics >>/tmp/crabbox-runtime-tools.log 2>&1 || true
  fi
  cat /tmp/crabbox-runtime-tools.log
  exit 72
fi
installed_codex="$(npm list -g @openai/codex --depth=0 --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const v=JSON.parse(s).dependencies?.["@openai/codex"]?.version||""; if (v) console.log(v);}catch{}})' || true)"
latest_codex="$(npm view @openai/codex version 2>/dev/null || true)"
if [ -z "$installed_codex" ] || { [ -n "$latest_codex" ] && [ "$installed_codex" != "$latest_codex" ]; }; then
  if command -v timeout >/dev/null 2>&1; then
    timeout 120s npm install -g @openai/codex@latest >/tmp/crabbox-codex-install.log 2>&1
  else
    npm install -g @openai/codex@latest >/tmp/crabbox-codex-install.log 2>&1
  fi
fi
rm -f "$HOME/.config/crabbox/github-credential" 2>/dev/null || true
rm -rf "$HOME/.config/gh" "$HOME/.local/share/gh" 2>/dev/null || true
git config --global --unset-all credential.helper 2>/dev/null || true
git config --global credential.helper "!f() { test \\"\\$1\\" = get || exit 0; printf 'username=x-access-token\\n'; printf 'password=%s\\n' ${shellQuote(sandboxPlaceholderGitHubToken)}; }; f"
git config --global user.name ${shellQuote(session.owner)}
git config --global user.email ${shellQuote(sandboxGitAuthorEmail(session.owner))}
mkdir -p "$(dirname ${shellQuote(autostartScript)})"
cat > ${shellQuote(autostartScript)} <<'EOF'
export CODEX_HOME="$HOME/.codex"
export GITHUB_TOKEN=${shellQuote(sandboxPlaceholderGitHubToken)}
export GH_TOKEN=${shellQuote(sandboxPlaceholderGitHubToken)}
export CRABBOX_SESSION_ID=${shellQuote(session.id)}
export CRABFLEET_SESSION_ID=${shellQuote(session.id)}
export CRABFLEET_PARENT_SESSION_ID=${shellQuote(session.parentSessionId ?? "")}
export CRABFLEET_ROOT_SESSION_ID=${shellQuote(session.rootSessionId ?? session.id)}
export CRABFLEET_AGENT_TOKEN=${shellQuote(agentToken ?? "")}
export CRABFLEET_API_URL=${shellQuote(deploymentConfig(env).canonicalUrl)}
export CRABBOX_REPO=${shellQuote(session.repo)}
export CRABBOX_BRANCH=${shellQuote(session.branch)}
export CRABBOX_RUNTIME=${shellQuote(session.runtime)}
export CRABBOX_COMMAND=${shellQuote(session.command)}
export CRABBOX_CHECKOUT_ERROR=${shellQuote(sandboxCheckoutErrorPath(session.id))}
export CRABBOX_WORKDIR=${shellQuote(workdir)}
if [ -z "\${CRABBOX_SHELL_BOOTSTRAPPED:-}" ]; then
  export CRABBOX_SHELL_BOOTSTRAPPED=1
  cd "$CRABBOX_WORKDIR" 2>/dev/null || true
fi
if [ -z "\${CRABBOX_CODEX_AUTOSTART_CHECKED:-}" ]; then
  export CRABBOX_CODEX_AUTOSTART_CHECKED=1
  crabbox_autostart_marker="$HOME/.cache/crabbox/\${CRABBOX_SESSION_ID:-session}.codex-autostarted"
  mkdir -p "$HOME/.cache/crabbox" 2>/dev/null || true
  if [ ! -e "$crabbox_autostart_marker" ]; then
    if [ -s "\${CRABBOX_CHECKOUT_ERROR:-}" ]; then
      printf '\\nCrabfleet repository checkout failed:\\n'
      cat "$CRABBOX_CHECKOUT_ERROR"
      printf '\\n'
    elif [ -n "\${CRABBOX_COMMAND:-}" ]; then
      touch "$crabbox_autostart_marker" 2>/dev/null || true
      (
        cd "$CRABBOX_WORKDIR" 2>/dev/null || {
          printf 'Crabfleet workdir is unavailable: %s\\n' "$CRABBOX_WORKDIR"
          exit 127
        }
        env -u BASH_ENV -u PROMPT_COMMAND /bin/bash -c "$CRABBOX_COMMAND"
      )
    fi
  fi
fi
EOF
marker=${shellQuote(sandboxBashrcMarker(session))}
bashrc_tmp="$HOME/.bashrc.crabbox.$$"
{
  printf '%s\\n' "$marker"
  printf '%s\\n' 'source ${shellQuote(autostartScript)} 2>/dev/null || true'
  if [ -f "$HOME/.bashrc" ]; then
    awk -v marker="$marker" '$0 == marker { getline; next } { print }' "$HOME/.bashrc"
  fi
} > "$bashrc_tmp"
mv "$bashrc_tmp" "$HOME/.bashrc"
cat > ${shellQuote(terminalShell)} <<'EOF'
#!/bin/bash
cd ${shellQuote(workdir)} 2>/dev/null || true
source ${shellQuote(autostartScript)} 2>/dev/null || true
exec /bin/bash -i
EOF
chmod +x ${shellQuote(terminalShell)}
`,
    {
      timeout: 300_000,
      env: commandEnv,
    },
  );
  if (!result.success) {
    throw new Error(clean(result.stderr || result.stdout || "runtime tool setup failed", 700));
  }
}

async function ensureSandboxTerminalPrepared(
  sandbox: CloudflareSandbox,
  env: RuntimeEnv,
  session: InteractiveSession & { githubToken?: string },
  terminalSessionId: string,
): Promise<void> {
  const workdir = sandboxWorkdir(session.id);
  try {
    if (await sandboxTerminalProfileExists(sandbox, session, workdir)) return;
    await setupSandboxTerminalSession(sandbox, env, session, workdir, terminalSessionId);
    return;
  } catch {
    // Missing or terminated default shell; recreate the sandbox below.
  }
  await recreateSandboxTerminalSession(sandbox, env, session, terminalSessionId);
}

async function sandboxTerminalProfileExists(
  sandbox: CloudflareSandbox,
  session: InteractiveSession & { githubToken?: string },
  workdir: string,
): Promise<boolean> {
  const setup = await createSandboxSession(
    sandbox,
    sandboxSetupSessionId(session.id),
    "/workspace",
    {
      CRABBOX_SESSION_ID: session.id,
    },
  );
  const marker = shellQuote(sandboxBashrcMarker(session));
  const autostartScript = sandboxAutostartScriptPath(session.id);
  const terminalShell = sandboxTerminalShellPath(session.id);
  const repoUrl = `https://github.com/${session.repo}.git`;
  const checks = [
    `test -d ${shellQuote(workdir)}`,
    `test -d ${shellQuote(workdir)}/.git`,
    `test ! -s ${shellQuote(sandboxCheckoutErrorPath(session.id))}`,
    `git -C ${shellQuote(workdir)} rev-parse --verify HEAD >/dev/null`,
    `test "$(git -C ${shellQuote(workdir)} rev-parse --abbrev-ref HEAD)" = ${shellQuote(session.branch)}`,
    `test "$(git -C ${shellQuote(workdir)} config --get remote.origin.url)" = ${shellQuote(repoUrl)}`,
    `test -s ${shellQuote(autostartScript)}`,
    `test -x ${shellQuote(terminalShell)}`,
    `grep -Fqx '[shell_environment_policy]' "$HOME/.codex/config.toml"`,
    `grep -Fqx '[projects."/workspace"]' "$HOME/.codex/config.toml"`,
    `node -e 'const fs=require("fs"); const p=process.env.HOME+"/.codex/auth.json"; const auth=JSON.parse(fs.readFileSync(p,"utf8")); process.exit(auth.OPENAI_API_KEY==="crabfleet-worker-injected"?0:1)'`,
    `grep -Fqx '        cd "$CRABBOX_WORKDIR" 2>/dev/null || {' ${shellQuote(autostartScript)}`,
    `grep -Fqx ${marker} "$HOME/.bashrc"`,
    `test ! -e "$HOME/.config/crabbox/github-credential"`,
  ];
  const result = await setup.exec(checks.join(" && "), { timeout: 10_000 });
  return result.success;
}

async function recreateSandboxTerminalSession(
  sandbox: CloudflareSandbox,
  env: RuntimeEnv,
  session: InteractiveSession & { githubToken?: string },
  terminalSessionId: string,
): Promise<void> {
  await setupSandboxTerminalSession(
    sandbox,
    env,
    session,
    sandboxWorkdir(session.id),
    terminalSessionId,
  );
}

function sandboxHasGitHubCredential(env: RuntimeEnv, session: SandboxRuntimeSession): boolean {
  return Boolean(("githubToken" in session && session.githubToken) || env.GITHUB_TOKEN);
}

async function createNewSandboxSession(
  sandbox: CloudflareSandbox,
  id: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<SandboxExecutionSession> {
  return sandbox.createSession({
    id,
    cwd,
    env: compactEnvVars(env),
    commandTimeoutMs: 300_000,
  });
}

function compactEnvVars(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}

function shellQuote(value: string): string {
  return `'${String(value ?? "").replace(/'/g, `'"'"'`)}'`;
}
