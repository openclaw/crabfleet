export function normalizeAdminPolicy({ cap, retention, merge }) {
  const rawCap = Number(cap);
  return {
    cap: Number.isFinite(rawCap) ? Math.min(200, Math.max(1, rawCap)) : 20,
    retention,
    merge,
  };
}
