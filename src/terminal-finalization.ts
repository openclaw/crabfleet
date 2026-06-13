export type TerminalArchiveState = {
  eventCount: number;
  archiveEventCount: number | null;
  archiveObjectsReady: boolean;
  archiveSessionVersionMatches: boolean;
};

export type TerminalFinalizationOperations = {
  ensureEvent: () => Promise<boolean>;
  readArchiveState: () => Promise<TerminalArchiveState>;
  archive: () => Promise<void>;
  clearPending: () => Promise<boolean>;
};

export function terminalArchiveNeedsRefresh(
  eventInserted: boolean,
  state: TerminalArchiveState,
): boolean {
  return (
    eventInserted ||
    state.archiveEventCount === null ||
    state.archiveEventCount < state.eventCount ||
    !state.archiveObjectsReady ||
    !state.archiveSessionVersionMatches
  );
}

export async function completeTerminalFinalization(
  operations: TerminalFinalizationOperations,
): Promise<void> {
  const eventInserted = await operations.ensureEvent();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await operations.readArchiveState();
    if (terminalArchiveNeedsRefresh(eventInserted && attempt === 0, state)) {
      await operations.archive();
    }
    const verified = await operations.readArchiveState();
    if (terminalArchiveNeedsRefresh(false, verified)) continue;
    if (await operations.clearPending()) return;
  }
  throw new Error("terminal archive coverage changed during finalization");
}
