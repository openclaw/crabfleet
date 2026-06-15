import { verifyOpenClawEmbedTicket } from "../openclaw-service.ts";
import type { RuntimeEnv } from "./env.ts";

export function openClawEmbedTicketSecret(
  env: Pick<RuntimeEnv, "CRABBOX_EMBED_TICKET_SECRET">,
): string {
  return env.CRABBOX_EMBED_TICKET_SECRET || "";
}

export async function isOpenClawEmbedSessionToken(
  env: Pick<RuntimeEnv, "CRABBOX_EMBED_TICKET_SECRET">,
  sessionId: string,
  token: string,
  now = Date.now(),
): Promise<boolean> {
  const secret = openClawEmbedTicketSecret(env);
  return Boolean(
    secret && token && (await verifyOpenClawEmbedTicket(secret, token, sessionId, now)),
  );
}

export async function canControlOpenClawEmbeddedTerminalRequest(
  request: Request,
  env: Pick<RuntimeEnv, "CRABBOX_EMBED_TICKET_SECRET">,
  sessionId: string,
  now = Date.now(),
): Promise<boolean> {
  const url = new URL(request.url);
  const shareSession = url.searchParams.get("shareSession") ?? "";
  const token = url.searchParams.get("token") ?? "";
  return (
    shareSession === sessionId && (await isOpenClawEmbedSessionToken(env, sessionId, token, now))
  );
}
