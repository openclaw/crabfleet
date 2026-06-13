export function cachedBooleanGrant(
  read: () => Promise<boolean>,
  ttlMs = 1000,
  now: () => number = Date.now,
): () => Promise<boolean> {
  let cached = false;
  let validUntil = 0;
  let inFlight: Promise<boolean> | null = null;
  return async () => {
    const checkedAt = now();
    if (checkedAt < validUntil) return cached;
    if (!inFlight) {
      inFlight = Promise.resolve()
        .then(read)
        .catch(() => false)
        .then((allowed) => {
          cached = allowed;
          validUntil = now() + ttlMs;
          return allowed;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };
}
