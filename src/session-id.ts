export const allocateInteractiveSessionIdSql = `
INSERT INTO id_sequences (name, last_id)
VALUES ('interactive_sessions', 101)
ON CONFLICT(name) DO UPDATE SET last_id = id_sequences.last_id + 1
RETURNING last_id AS next_id
`;

export function formatInteractiveSessionId(value: number): string | null {
  return Number.isSafeInteger(value) && value > 100 ? `IS-${value}` : null;
}
