import type { RuntimeEnv } from "./env.ts";
import { userSessionOwnerSubject, userTenantSubject, type User } from "./models.ts";

export type TenancyMode = "shared" | "private";
export const bootstrapTenantSubject = "bootstrap:owner";

export function tenancyMode(env: Pick<RuntimeEnv, "CRABFLEET_TENANCY_MODE">): TenancyMode {
  return env.CRABFLEET_TENANCY_MODE === "shared" ? "shared" : "private";
}

export function tenantSubject(user: User): string {
  return stableTenantSubject(user[userTenantSubject] || user.subject);
}

export function sessionOwnerSubject(user: User): string {
  return stableTenantSubject(user[userSessionOwnerSubject] || tenantSubject(user));
}

export function stableTenantSubject(subject: string): string {
  return subject.startsWith("bootstrap:") ? bootstrapTenantSubject : subject;
}
