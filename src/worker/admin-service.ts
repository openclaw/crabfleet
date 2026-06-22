import type { AdminMutationStore, AdminPolicy } from "./admin-repository.ts";
import { badRequest, forbidden } from "./http.ts";
import type { Role, User } from "./models.ts";
import { githubRepoParts, normalizeRepo } from "./repositories.ts";
import type { RepoWorkflow } from "./workflow-model.ts";

export type AdminPolicyInput = {
  cap?: unknown;
  retention?: unknown;
  merge?: unknown;
};

export type AdminWorkflowInput = {
  repo?: unknown;
};

export type AdminAllowEntryInput = {
  value?: unknown;
  role?: unknown;
};

export type AdminRepoInput = {
  repo?: unknown;
};

export type AdminServiceDependencies = {
  store: AdminMutationStore;
  preferredRepo: string;
  now(): number;
  refreshWorkflow(repo: string, now: number): Promise<RepoWorkflow>;
  audit(user: User, message: string, now: number): Promise<void>;
};

export class AdminService {
  private readonly dependencies: AdminServiceDependencies;

  constructor(dependencies: AdminServiceDependencies) {
    this.dependencies = dependencies;
  }

  async updatePolicy(input: AdminPolicyInput, user: User): Promise<AdminPolicy> {
    requireAdminUser(user);
    const policy = {
      cap: Math.min(200, Math.max(1, Number.isFinite(input.cap) ? Number(input.cap) : 20)),
      retention: oneOf(input.retention, ["14", "30", "60"], "30"),
      merge: oneOf(input.merge, ["guarded", "maintainers", "disabled"], "guarded"),
    };
    const now = this.dependencies.now();
    await this.dependencies.store.writePolicy(policy);
    await this.dependencies.audit(
      user,
      `policy updated cap=${policy.cap} retention=${policy.retention} merge=${policy.merge}`,
      now,
    );
    return policy;
  }

  async evaluateWorkflow(input: AdminWorkflowInput, user: User): Promise<RepoWorkflow> {
    requireAdminUser(user);
    const repo = normalizeRepo(input.repo) || this.dependencies.preferredRepo;
    await this.dependencies.store.requireRepo(repo);
    const now = this.dependencies.now();
    const workflow = await this.dependencies.refreshWorkflow(repo, now);
    await this.dependencies.audit(
      user,
      `workflow evaluated ${repo} status=${workflow.status}`,
      now,
    );
    return workflow;
  }

  async addAllowEntry(
    input: AdminAllowEntryInput,
    user: User,
  ): Promise<{ value: string; role: Role }> {
    requireAdminUser(user);
    const value = normalizeAllow(input.value);
    if (!value) throw badRequest("allow value is required");
    const role = oneOf(input.role, ["viewer", "maintainer", "owner"], "maintainer") as Role;
    const now = this.dependencies.now();
    await this.dependencies.store.upsertAllowEntry(value, role, now);
    await this.dependencies.audit(user, `allowlist updated ${value} role=${role}`, now);
    return { value, role };
  }

  async removeAllowEntry(value: string, user: User): Promise<string> {
    requireAdminUser(user);
    const normalized = normalizeAllow(value);
    const now = this.dependencies.now();
    await this.dependencies.store.removeAllowEntry(normalized);
    await this.dependencies.audit(user, `allowlist removed ${normalized}`, now);
    return normalized;
  }

  async addRepo(input: AdminRepoInput, user: User): Promise<string> {
    requireAdminUser(user);
    const repo = normalizeRepo(input.repo);
    if (!repo) throw badRequest("repo is required");
    if (!githubRepoParts(repo)) throw badRequest("repo must be a GitHub owner/name");
    const now = this.dependencies.now();
    await this.dependencies.store.upsertRepo(repo, now);
    await this.dependencies.audit(user, `repo allowlisted ${repo}`, now);
    return repo;
  }

  async removeRepo(repo: string, user: User): Promise<string> {
    requireAdminUser(user);
    const normalized = normalizeRepo(repo);
    if (!normalized) throw badRequest("repo is required");
    if (!githubRepoParts(normalized)) throw badRequest("repo must be a GitHub owner/name");
    const now = this.dependencies.now();
    await this.dependencies.store.disableRepo(normalized, now);
    await this.dependencies.audit(user, `repo removed ${normalized}`, now);
    return normalized;
  }
}

function requireAdminUser(user: User): void {
  if (!user.allowed || user.role !== "owner") {
    throw forbidden("admin owner role required");
  }
}

function normalizeAllow(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.includes("@")) return raw.toLowerCase();
  return `@${raw.toLowerCase()}`;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}
