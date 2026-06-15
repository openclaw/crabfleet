export function clampedSeconds(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(86_400, Math.max(300, Math.trunc(parsed)));
}
