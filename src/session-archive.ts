export type SessionArchiveObjectKeys = {
  events_key: string | null;
  transcript_key: string | null;
  summary_key: string | null;
};

export type PopulatedSessionArchiveObjectKeys = {
  events_key: string;
  transcript_key: string;
  summary_key: string;
};

export function sessionArchiveAttemptKeys(
  archiveBase: string,
  eventCount: number,
  latestEventAt: number,
  now: number,
  attemptId: string,
): PopulatedSessionArchiveObjectKeys {
  const version = `${String(eventCount).padStart(8, "0")}-${String(latestEventAt).padStart(13, "0")}-${now}-${attemptId}`;
  const base = `${archiveBase}/${version}`;
  return {
    events_key: `${base}/events.ndjson`,
    transcript_key: `${base}/transcript.md`,
    summary_key: `${base}/summary.json`,
  };
}

export function sameSessionArchiveObjectKeys(
  left: SessionArchiveObjectKeys | undefined,
  right: SessionArchiveObjectKeys | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.events_key === right.events_key &&
    left.transcript_key === right.transcript_key &&
    left.summary_key === right.summary_key,
  );
}

export function obsoleteSessionArchiveObjectKeys(
  latest: SessionArchiveObjectKeys | undefined,
  previous: SessionArchiveObjectKeys | undefined,
  attempted: PopulatedSessionArchiveObjectKeys,
): SessionArchiveObjectKeys | undefined {
  const candidate = sameSessionArchiveObjectKeys(latest, attempted) ? previous : attempted;
  return sameSessionArchiveObjectKeys(candidate, latest) ? undefined : candidate;
}
