import { badRequest } from "./http.ts";
import type { User } from "./models.ts";
import { tenantSubject } from "./tenancy.ts";
import type { DesktopHostRow, DesktopHostStore } from "./desktop-host-repository.ts";

export type DesktopHostInput = {
  name?: unknown;
  address?: unknown;
  port?: unknown;
};

export type DesktopHost = {
  id: string;
  owner: string;
  name: string;
  address: string;
  port: number;
  createdAt: number;
  updatedAt: number;
};

export type DesktopHostRegistration = {
  host: DesktopHost;
  ownershipToken?: string;
};

export const desktopHostOwnershipHeader = "x-crabfleet-ownership-token";
export const desktopHostOwnershipModeHeader = "x-crabfleet-ownership-mode";
export const desktopHostPublicationHeader = "x-crabfleet-publication-id";
export const desktopHostTokenOwnershipMode = "token-v1";
export type DesktopHostOwnershipMode = "legacy" | typeof desktopHostTokenOwnershipMode;

export class DesktopHostService {
  private readonly store: DesktopHostStore;
  private readonly now: () => number;
  private readonly createOwnershipToken: () => string;

  constructor(
    store: DesktopHostStore,
    now: () => number = Date.now,
    createOwnershipToken: () => string = randomOwnershipToken,
  ) {
    this.store = store;
    this.now = now;
    this.createOwnershipToken = createOwnershipToken;
  }

  async list(user: User): Promise<DesktopHost[]> {
    const rows = await this.store.list(tenantSubject(user));
    return rows.map(presentDesktopHost);
  }

  async register(
    user: User,
    rawID: string,
    input: DesktopHostInput,
    ownershipMode: DesktopHostOwnershipMode = "legacy",
    rawPublicationID: unknown = null,
  ): Promise<DesktopHostRegistration> {
    const id = desktopHostID(rawID);
    const name = boundedText(input.name, "name", 100);
    const address = tailscaleIPv4(input.address);
    const port = desktopHostPort(input.port);
    const now = this.now();
    const publicationID =
      ownershipMode === desktopHostTokenOwnershipMode
        ? desktopHostPublicationID(rawPublicationID)
        : "";
    const ownershipToken =
      ownershipMode === desktopHostTokenOwnershipMode ? this.createOwnershipToken() : "";
    const host: DesktopHostRow = {
      ownerSubject: tenantSubject(user),
      id,
      owner: user.login || user.email || user.name || user.subject,
      name,
      address,
      port,
      ownershipToken,
      publicationID,
      createdAt: now,
      updatedAt: now,
    };
    const registration: DesktopHostRegistration = {
      host: presentDesktopHost(await this.store.upsert(host)),
    };
    if (ownershipToken) registration.ownershipToken = ownershipToken;
    return registration;
  }

  async recover(
    user: User,
    rawID: string,
    rawPublicationID: unknown,
  ): Promise<{ ownershipToken: string | null }> {
    const ownershipToken = await this.store.ownershipTokenForPublication(
      tenantSubject(user),
      desktopHostID(rawID),
      desktopHostPublicationID(rawPublicationID),
    );
    return { ownershipToken };
  }

  async remove(user: User, rawID: string, rawOwnershipToken: unknown): Promise<void> {
    await this.store.remove(
      tenantSubject(user),
      desktopHostID(rawID),
      desktopHostOwnershipToken(rawOwnershipToken),
    );
  }
}

function randomOwnershipToken(): string {
  return crypto.randomUUID() + crypto.randomUUID();
}

function presentDesktopHost(row: DesktopHostRow): DesktopHost {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    address: row.address,
    port: row.port,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function desktopHostID(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/.test(normalized)) {
    throw badRequest(
      "desktop host id must contain 1-80 lowercase letters, numbers, dots, dashes, or underscores",
    );
  }
  return normalized;
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw badRequest(`${field} is required`);
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    new TextEncoder().encode(normalized).byteLength > maximum ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw badRequest(`${field} is invalid`);
  }
  return normalized;
}

function tailscaleIPv4(value: unknown): string {
  if (typeof value !== "string") throw badRequest("address is required");
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9][0-9]{0,2})$/.test(part))) {
    throw badRequest("address must be a Tailscale IPv4 address");
  }
  const octets = parts.map(Number);
  const firstOctet = octets[0] ?? -1;
  const secondOctet = octets[1] ?? -1;
  if (
    octets.some((octet) => octet < 0 || octet > 255) ||
    firstOctet !== 100 ||
    secondOctet < 64 ||
    secondOctet > 127
  ) {
    throw badRequest("address must be in 100.64.0.0/10");
  }
  return octets.join(".");
}

function desktopHostPort(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw badRequest("port must be an integer from 1 to 65535");
  }
  return value;
}

function desktopHostOwnershipToken(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 200 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x20 || codePoint === 0x7f;
    })
  ) {
    throw badRequest("desktop host ownership token is required");
  }
  return value;
}

function desktopHostPublicationID(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 200 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x20 || codePoint === 0x7f;
    })
  ) {
    throw badRequest("desktop host publication id is required");
  }
  return value;
}
