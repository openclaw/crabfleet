const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const openClawTranscriptMaxBytes = 64 * 1024;
export const openClawRoomMaxSessions = 64;
export const openClawEmbedTicketDefaultSeconds = 60 * 60;
export const openClawEmbedTicketMaxSeconds = 4 * 60 * 60;

const openClawEmbedTicketVersion = "v1";
const openClawEmbedTicketAudience = "crabfleet-embed";

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

export function openClawEmbedTicketTtlSeconds(value?: number): number {
	if (value === undefined) return openClawEmbedTicketDefaultSeconds;
	return Math.max(60, Math.min(openClawEmbedTicketMaxSeconds, Math.floor(value)));
}

export async function createOpenClawEmbedTicket(
	secret: string,
	sessionId: string,
	expiresAt: number,
): Promise<string> {
	if (!secret || !sessionId || !Number.isSafeInteger(expiresAt)) {
		throw new Error("invalid OpenClaw embed ticket input");
	}
	const payload = base64UrlFromBytes(
		encoder.encode(
			JSON.stringify({
				aud: openClawEmbedTicketAudience,
				sessionId,
				expiresAt,
			}),
		),
	);
	const message = `${openClawEmbedTicketVersion}.${payload}`;
	const signature = await crypto.subtle.sign(
		"HMAC",
		await openClawEmbedTicketKey(secret),
		encoder.encode(message),
	);
	return `${message}.${base64UrlFromBytes(new Uint8Array(signature))}`;
}

export async function verifyOpenClawEmbedTicket(
	secret: string,
	token: string,
	sessionId: string,
	now = Date.now(),
): Promise<boolean> {
	if (!secret || !token || !sessionId) return false;
	const parts = token.split(".");
	if (parts.length !== 3 || parts[0] !== openClawEmbedTicketVersion) return false;
	try {
		const message = `${parts[0]}.${parts[1]}`;
		const signatureValid = await crypto.subtle.verify(
			"HMAC",
			await openClawEmbedTicketKey(secret),
			bytesFromBase64Url(parts[2]!),
			encoder.encode(message),
		);
		if (!signatureValid) return false;
		const payload = JSON.parse(decoder.decode(bytesFromBase64Url(parts[1]!))) as unknown;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
		const fields = payload as Record<string, unknown>;
		return (
			fields.aud === openClawEmbedTicketAudience &&
			fields.sessionId === sessionId &&
			typeof fields.expiresAt === "number" &&
			Number.isSafeInteger(fields.expiresAt) &&
			fields.expiresAt > now
		);
	} catch {
		return false;
	}
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

export function openClawGitBranchAllowed(branch: string): boolean {
  if (!branch || branch.length > 120 || branch !== branch.trim()) return false;
  if (
    branch === "@" ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//")
  ) {
    return false;
  }
  if (
    [...branch].some(
      (character) =>
        character.charCodeAt(0) <= 32 ||
        character.charCodeAt(0) === 127 ||
        "~^:?*[\\".includes(character),
    )
  ) {
    return false;
  }
  return branch
    .split("/")
    .every((part) => Boolean(part) && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function openClawGitHubRepoParts(repo: string): { owner: string; name: string } | null {
  const parts = repo.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (
    !owner ||
    !name ||
    !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(owner) ||
    !/^[a-z0-9._-]{1,100}$/i.test(name)
  ) {
    return null;
  }
  return { owner, name };
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

async function openClawEmbedTicketKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

function base64UrlFromBytes(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function bytesFromBase64Url(value: string): Uint8Array {
	const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
	const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
