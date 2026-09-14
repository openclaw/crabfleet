import type { AdminRepository } from "./admin-repository.ts";
import { badRequest, forbidden } from "./http.ts";
import type { Role, User } from "./models.ts";

export type AdminAllowEntryInput = { value?: unknown; role?: unknown };
export type AdminServiceDependencies = {
  store: AdminRepository;
  now(): number;
  audit(user: User, message: string, now: number): Promise<void>;
};

export class AdminService {
  private readonly dependencies: AdminServiceDependencies;
  constructor(dependencies: AdminServiceDependencies) {
    this.dependencies = dependencies;
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
