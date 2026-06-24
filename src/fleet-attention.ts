export type FleetAttentionSession = {
  status?: string;
  expiresAt?: number | null;
  reconcileError?: string | null;
  reconciliationNeedsAttention?: boolean;
  lastEvent?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
};

const fleetProvisioningStaleMs = 15 * 60_000;
const expectedProvisioningEvidence = new Set(["runtime adapter create pending"]);

export function hasActionableReconciliationError(value: string | null | undefined): boolean {
  const evidence = value?.trim();
  return Boolean(evidence && !expectedProvisioningEvidence.has(evidence));
}

export function fleetSessionAttentionReason(
  session: FleetAttentionSession,
  generatedAt: number,
): string | null {
  const reconcileError = session.reconcileError?.trim() || null;
  const lastEvent = session.lastEvent?.trim() || null;
  if (session.status === "failed") {
    return reconcileError ?? lastEvent ?? "Interactive workspace failed";
  }
  if (session.status === "stopping") {
    return reconcileError ?? "Workspace release in progress";
  }
  if (session.status === "pending_adapter") {
    return reconcileError ?? lastEvent ?? "Interactive runtime unavailable";
  }
  if (session.status !== "provisioning") return null;
  if (
    session.expiresAt !== null &&
    session.expiresAt !== undefined &&
    session.expiresAt <= generatedAt
  ) {
    return "Provisioning lease expired";
  }
  if (hasActionableReconciliationError(reconcileError)) return reconcileError;
  if (session.reconciliationNeedsAttention) return "Provisioning needs operator attention";
  const lastProgressAt = Math.max(session.createdAt ?? 0, session.updatedAt ?? 0);
  if (lastProgressAt > 0 && generatedAt - lastProgressAt >= fleetProvisioningStaleMs) {
    return "Provisioning has not made progress for 15 minutes";
  }
  return null;
}
