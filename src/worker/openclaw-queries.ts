import {
  boundedUtf8Tail,
  openClawRoomRootAllowed,
  openClawRoomSessionChainAllowed,
} from "../openclaw-service.ts";
import { notFound, serviceUnavailable } from "./http.ts";
import type { InteractiveSession } from "./session-model.ts";

export const openClawTranscriptEventLimit = 240;
export const openClawTranscriptEventWindow = openClawTranscriptEventLimit + 1;

export type OpenClawRoomRead = {
  sessions: InteractiveSession[];
  overflow: boolean;
};

export function openClawVisibleRoomSessions(
  rootSessionId: string,
  root: InteractiveSession | null,
  room: OpenClawRoomRead,
): InteractiveSession[] {
  if (!root || !openClawRoomRootAllowed(root)) {
    throw notFound("session root not found");
  }
  if (!room.sessions.length) throw notFound("session root not found");
  if (room.overflow) {
    throw serviceUnavailable("session root exceeds the supervision limit");
  }
  return room.sessions.filter((session) =>
    openClawRoomSessionChainAllowed(room.sessions, session.id, rootSessionId),
  );
}

export function openClawSessionSummary(session: InteractiveSession): InteractiveSession {
  return { ...session, logs: [] };
}

export function buildOpenClawTranscript<Event>(
  eventWindow: Event[],
  eventCount: number,
  render: (events: Event[]) => string,
): {
  transcript: string;
  eventCount: number;
  truncated: boolean;
} {
  const hasMoreEvents = eventWindow.length > openClawTranscriptEventLimit;
  const events = hasMoreEvents ? eventWindow.slice(1) : eventWindow;
  const transcript = boundedUtf8Tail(render(events));
  return {
    transcript: transcript.text,
    eventCount,
    truncated: transcript.truncated || hasMoreEvents || eventCount > events.length,
  };
}
