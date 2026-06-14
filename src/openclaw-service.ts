const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const openClawTranscriptMaxBytes = 64 * 1024;

export function sessionBelongsToRoot(
	sessionId: string,
	sessionRootId: string | null,
	expectedRootId: string,
): boolean {
	return Boolean(expectedRootId) && (sessionRootId || sessionId) === expectedRootId;
}

export function boundedUtf8Tail(
	value: string,
	maxBytes = openClawTranscriptMaxBytes,
): { text: string; truncated: boolean } {
	const bytes = encoder.encode(value);
	if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
	const tail = decoder.decode(bytes.slice(bytes.byteLength - maxBytes)).replace(/^\uFFFD/, "");
	return { text: tail, truncated: true };
}
