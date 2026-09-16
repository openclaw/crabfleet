import { requireRole } from "../auth.ts";
import {
  desktopHostOwnershipHeader,
  desktopHostOwnershipModeHeader,
  desktopHostPublicationHeader,
  desktopHostTokenOwnershipMode,
  type DesktopHostInput,
  type DesktopHostService,
} from "../desktop-host-service.ts";
import { decodePathIdentifier, json, readJson } from "../http.ts";
import type { User } from "../models.ts";

export async function handleDesktopHostRoute(
  request: Request,
  url: URL,
  user: User,
  hosts: DesktopHostService,
): Promise<Response | null> {
  const desktopHostMatch = url.pathname.match(/^\/api\/desktop-hosts\/([^/]+)$/);
  if (request.method === "PUT" && desktopHostMatch) {
    requireRole(user, "viewer");
    const registration = await hosts.register(
      user,
      decodePathIdentifier(desktopHostMatch[1]),
      await readJson<DesktopHostInput>(request),
      request.headers.get(desktopHostOwnershipModeHeader) === desktopHostTokenOwnershipMode
        ? desktopHostTokenOwnershipMode
        : "legacy",
      request.headers.get(desktopHostPublicationHeader),
    );
    return json(registration);
  }
  if (request.method === "POST" && desktopHostMatch && url.searchParams.get("recover") === "1") {
    requireRole(user, "viewer");
    const body = await readJson<{ publicationID?: unknown }>(request);
    return json(
      await hosts.recover(user, decodePathIdentifier(desktopHostMatch[1]), body.publicationID),
    );
  }
  if (request.method === "DELETE" && desktopHostMatch) {
    requireRole(user, "viewer");
    const ownershipToken = request.headers.get(desktopHostOwnershipHeader);
    await hosts.remove(user, decodePathIdentifier(desktopHostMatch[1]), ownershipToken);
    return json({ ok: true });
  }
  return null;
}
