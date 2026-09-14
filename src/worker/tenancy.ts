import { userTenantSubject, type User } from "./models.ts";

export const bootstrapTenantSubject = "bootstrap:owner";

export function tenantSubject(user: User): string {
  return stableTenantSubject(user[userTenantSubject] || user.subject);
}

export function stableTenantSubject(subject: string): string {
  return subject.startsWith("bootstrap:") ? bootstrapTenantSubject : subject;
}
