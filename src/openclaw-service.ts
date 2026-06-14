const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const openClawTranscriptMaxBytes = 64 * 1024;
export const openClawRoomMaxSessions = 64;

type OpenClawSessionFence = {
	id: string;
	parentSessionId: string | null;
	rootSessionId: string | null;
	runtime: string;
	createdBy: string;
	workKey: string | null;
};

export function openClawServiceAuthorized(
	authorization: string | null,
	tokens: Array<string | null | undefined>,
): boolean {
	return tokens.some((token) => Boolean(token) && authorization === `Bearer ${token}`);
}

export function sessionBelongsToRoot(
	sessionId: string,
	sessionRootId: string | null,
	expectedRootId: string,
): boolean {
	return Boolean(expectedRootId) && (sessionRootId || sessionId) === expectedRootId;
}

export function openClawRoomSessionAllowed(session: OpenClawSessionFence): boolean {
	return (
		(session.createdBy === "service:openclaw" ||
			(Boolean(session.parentSessionId) &&
				session.createdBy === `session:${session.parentSessionId}`)) &&
		session.runtime !== "github_actions" &&
		!session.workKey
	);
}

export function openClawRoomRootAllowed(session: OpenClawSessionFence): boolean {
	return (
		session.createdBy === "service:openclaw" &&
		openClawRoomSessionAllowed(session) &&
		(session.rootSessionId || session.id) === session.id
	);
}

export function openClawRoomSessionChainAllowed(
	sessions: OpenClawSessionFence[],
	sessionId: string,
	expectedRootId: string,
): boolean {
	const byId = new Map(sessions.map((session) => [session.id, session]));
	const root = byId.get(expectedRootId);
	if (!root || !openClawRoomRootAllowed(root)) return false;
	let current = byId.get(sessionId);
	const visited = new Set<string>();
	while (current && !visited.has(current.id)) {
		visited.add(current.id);
		if (
			!openClawRoomSessionAllowed(current) ||
			!sessionBelongsToRoot(current.id, current.rootSessionId, expectedRootId)
		) {
			return false;
		}
		if (current.id === expectedRootId) return true;
		if (!current.parentSessionId) return false;
		current = byId.get(current.parentSessionId);
	}
	return false;
}

export function openClawBranchPreparationCanDefer(status: number): boolean {
	return status === 403 || status === 404;
}

export function boundedUtf8Tail(
	value: string,
	maxBytes = openClawTranscriptMaxBytes,
): { text: string; truncated: boolean } {
	const bytes = encoder.encode(value);
	if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
	let start = bytes.byteLength - maxBytes;
	while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
	const tail = decoder.decode(bytes.slice(start));
	return { text: tail, truncated: true };
}
