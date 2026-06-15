import { legacyLeaseIdForAdapter } from "../runtime-adapter.ts";

export const sandboxLeasePrefix = "sandbox:";
export const sandboxLeaseProfile = "autostart-v4";

export type SandboxLease = {
  sandboxId: string;
  terminalSessionId: string;
};

export type SandboxLeaseRefreshFence = {
  claim: string;
  expiresAt: number;
  refreshLeaseId: string | null;
  sandboxId: string;
};

export type SandboxCurrentLeaseFence = {
  leaseId: string;
  sandboxId: string;
};

export type SandboxLeaseSource = {
  id: string;
  leaseId?: string | null;
  adapter?: string | null;
};

export function sandboxIdForSession(id: string): string {
  return clean(`crabbox-${id}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-"), 63);
}

export function newSandboxLease(id: string): SandboxLease {
  const suffix = crypto.randomUUID().slice(0, 8).toLowerCase();
  const base = sandboxIdForSession(id);
  const sandboxId = `${base.slice(0, 63 - suffix.length - 1)}-${suffix}`;
  return {
    sandboxId,
    terminalSessionId: sandboxTerminalSessionId(id, suffix),
  };
}

export function sandboxLeaseId(lease: SandboxLease): string {
  return `${sandboxLeasePrefix}${lease.sandboxId}:${lease.terminalSessionId}:${sandboxLeaseProfile}`;
}

export function isCurrentSandboxLease(leaseId: string | null | undefined): boolean {
  return (
    leaseId?.startsWith(sandboxLeasePrefix) === true && leaseId.endsWith(`:${sandboxLeaseProfile}`)
  );
}

export function sandboxLeaseRefreshStartedAt(leaseId: string): number | null {
  const match = /:refreshing-(\d+)-[a-f0-9]+$/.exec(leaseId);
  return match ? Number(match[1]) : null;
}

export function sandboxLeaseWithoutRefresh(leaseId: string): string {
  return leaseId.replace(/:refreshing-\d+-[a-f0-9]+$/, "");
}

export function sandboxLeaseInfo(source: SandboxLeaseSource): SandboxLease {
  const rawLease = legacyLeaseIdForAdapter(source.adapter ?? null, source.leaseId ?? null);
  const raw = rawLease?.startsWith(sandboxLeasePrefix)
    ? rawLease.slice(sandboxLeasePrefix.length)
    : "";
  const [sandboxId, terminalSessionId] = raw.split(":");
  return {
    sandboxId: clean(sandboxId, 80) || sandboxIdForSession(source.id),
    terminalSessionId: clean(terminalSessionId, 100) || sandboxTerminalSessionId(source.id),
  };
}

export function sandboxTerminalSessionId(id: string, suffix?: string): string {
  const base = clean(`terminal-${id}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-"), 80);
  if (!suffix) return base;
  return `${base.slice(0, 80 - suffix.length - 1)}-${suffix}`;
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
