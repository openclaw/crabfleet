import type { DesktopRelayRegistrationStore } from "./desktop-host-repository.ts";
import {
  desktopHostID,
  desktopHostOwnershipHeader,
  isDesktopHostOpaqueID,
} from "./desktop-host-service.ts";
import type { RuntimeEnv } from "./env.ts";
import {
  badRequest,
  decodePathIdentifier,
  forbidden,
  notFound,
  serviceUnavailable,
  unauthorized,
} from "./http.ts";
import type { User } from "./models.ts";
import { validateDesktopWebSocketOrigin } from "./desktop-origin.ts";
import { tenantSubject } from "./tenancy.ts";

export type DesktopRelayRoute = {
  hostID: string;
  role: "host" | "viewer";
};

export class DesktopRelayService {
  private readonly env: RuntimeEnv;
  private readonly registrations: DesktopRelayRegistrationStore;

  constructor(env: RuntimeEnv, registrations: DesktopRelayRegistrationStore) {
    this.env = env;
    this.registrations = registrations;
  }

  async openHost(request: Request, rawHostID: string): Promise<Response> {
    requireWebSocketUpgrade(request);
    const ownershipToken = request.headers.get(desktopHostOwnershipHeader);
    if (!ownershipToken) throw unauthorized();
    if (!isDesktopHostOpaqueID(ownershipToken)) throw forbidden("desktop relay ownership denied");
    const hostID = desktopHostID(rawHostID);
    const registration = await this.registrations.findTokenRegistration(hostID, ownershipToken);
    if (!registration) throw forbidden("desktop relay ownership denied");
    return this.openRelay(request, registration.ownerSubject, hostID, "host");
  }

  async openViewer(request: Request, user: User, rawHostID: string): Promise<Response> {
    requireWebSocketUpgrade(request);
    validateDesktopWebSocketOrigin(request, this.env);
    const hostID = desktopHostID(rawHostID);
    const ownerSubject = tenantSubject(user);
    const registration = await this.registrations.findOwnedTokenRegistration(ownerSubject, hostID);
    if (!registration) throw notFound("desktop host not found");
    return this.openRelay(request, ownerSubject, hostID, "viewer");
  }

  private openRelay(
    request: Request,
    ownerSubject: string,
    hostID: string,
    role: "host" | "viewer",
  ): Promise<Response> {
    const namespace = this.env.DESKTOP_RELAY;
    if (!namespace) throw serviceUnavailable("DESKTOP_RELAY Durable Object is not configured");
    const id = namespace.idFromName(`${ownerSubject}:${hostID}`);
    const stub = namespace.get(id);
    return stub.fetch(`https://crabfleet.internal/api/desktop-relay/${role}`, {
      headers: { upgrade: request.headers.get("upgrade") ?? "websocket" },
    });
  }
}

export function matchDesktopRelayRoute(url: URL): DesktopRelayRoute | null {
  const match = url.pathname.match(/^\/api\/desktop-hosts\/([^/]+)\/relay\/(host|viewer)$/);
  if (!match) return null;
  const hostID = decodePathIdentifier(match[1]);
  return { hostID, role: match[2] as DesktopRelayRoute["role"] };
}

function requireWebSocketUpgrade(request: Request): void {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw badRequest("websocket upgrade required");
  }
}
