export type Role = "viewer" | "maintainer" | "owner";

export const userTenantSubject = Symbol("userTenantSubject");

export type User = {
  [userTenantSubject]?: string;
  subject: string;
  login: string | null;
  email: string | null;
  name: string | null;
  role: Role;
  allowed: boolean;
  teams: string[];
};
