const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const openClawTranscriptMaxBytes = 64 * 1024;

type OpenClawSessionFence = {
	id: string;
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
		session.createdBy === "service:openclaw" &&
		session.runtime !== "github_actions" &&
		!session.workKey
	);
}

export function openClawRoomRootAllowed(session: OpenClawSessionFence): boolean {
	return (
		openClawRoomSessionAllowed(session) && (session.rootSessionId || session.id) === session.id
	);
}

export function openClawBranchPreparationCanDefer(status: number): boolean {
	return status === 403;
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
