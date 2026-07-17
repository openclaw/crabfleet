import { database, executeBatch } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import { conflict } from "./http.ts";

export type DesktopHostRow = {
  ownerSubject: string;
  id: string;
  owner: string;
  name: string;
  address: string;
  port: number;
  quicPort: number | null;
  quicCertHash: string | null;
  webtransport: boolean;
  ownershipToken: string;
  publicationID: string;
  createdAt: number;
  updatedAt: number;
};

export type DesktopHostWrite = Omit<DesktopHostRow, "quicPort" | "quicCertHash" | "webtransport"> &
  Partial<Pick<DesktopHostRow, "quicPort" | "quicCertHash" | "webtransport">>;

export interface DesktopHostStore {
  list(ownerSubject: string): Promise<DesktopHostRow[]>;
  upsert(host: DesktopHostWrite): Promise<DesktopHostRow>;
  ownershipTokenForPublication(
    ownerSubject: string,
    id: string,
    publicationID: string,
  ): Promise<string | null>;
  remove(ownerSubject: string, id: string, ownershipToken: string | null): Promise<void>;
}

export interface DesktopRelayRegistrationStore {
  findOwnedTokenRegistration(
    ownerSubject: string,
    id: string,
  ): Promise<DesktopRelayRegistration | null>;
  findTokenRegistration(
    id: string,
    ownershipToken: string,
  ): Promise<DesktopRelayRegistration | null>;
}

export type DesktopRelayRegistration = Pick<DesktopHostRow, "ownerSubject" | "id">;

export class DesktopHostRepository implements DesktopHostStore, DesktopRelayRegistrationStore {
  private readonly env: RuntimeEnv;

  constructor(env: RuntimeEnv) {
    this.env = env;
  }

  async list(ownerSubject: string): Promise<DesktopHostRow[]> {
    const rows = await database(this.env)
      .selectFrom("desktop_hosts")
      .selectAll()
      .where("owner_subject", "=", ownerSubject)
      .orderBy("updated_at", "desc")
      .orderBy("id")
      .execute();
    return rows.map((row) => ({
      quicPort: row.quic_port ?? null,
      quicCertHash: row.quic_cert_hash ?? null,
      webtransport: row.webtransport === 1,
      ownerSubject: row.owner_subject,
      id: row.id,
      owner: row.owner,
      name: row.name,
      address: row.address,
      port: row.port,
      ownershipToken: row.ownership_token,
      publicationID: row.publication_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async findOwnedTokenRegistration(
    ownerSubject: string,
    id: string,
  ): Promise<DesktopRelayRegistration | null> {
    const row = await database(this.env)
      .selectFrom("desktop_hosts")
      .select(["owner_subject", "id"])
      .where("owner_subject", "=", ownerSubject)
      .where("id", "=", id)
      .where("ownership_token", "<>", "")
      .executeTakeFirst();
    return row ? { ownerSubject: row.owner_subject, id: row.id } : null;
  }

  async findTokenRegistration(
    id: string,
    ownershipToken: string,
  ): Promise<DesktopRelayRegistration | null> {
    const row = await database(this.env)
      .selectFrom("desktop_hosts")
      .select(["owner_subject", "id"])
      .where("id", "=", id)
      .where("ownership_token", "=", ownershipToken)
      .where("ownership_token", "<>", "")
      .executeTakeFirst();
    return row ? { ownerSubject: row.owner_subject, id: row.id } : null;
  }

  async upsert(host: DesktopHostWrite): Promise<DesktopHostRow> {
    const row = await database(this.env)
      .insertInto("desktop_hosts")
      .values({
        quic_port: host.quicPort ?? null,
        quic_cert_hash: host.quicCertHash ?? null,
        webtransport: host.webtransport === true ? 1 : 0,
        owner_subject: host.ownerSubject,
        id: host.id,
        owner: host.owner,
        name: host.name,
        address: host.address,
        port: host.port,
        ownership_token: host.ownershipToken,
        publication_id: host.publicationID,
        publication_write_token: host.ownershipToken,
        created_at: host.createdAt,
        updated_at: host.updatedAt,
      })
      .onConflict((conflict) => {
        const update = conflict.columns(["owner_subject", "id"]);
        return host.ownershipToken
          ? update.doUpdateSet({
              quic_port: host.quicPort ?? null,
              quic_cert_hash: host.quicCertHash ?? null,
              webtransport: host.webtransport === true ? 1 : 0,
              owner: host.owner,
              name: host.name,
              address: host.address,
              port: host.port,
              ownership_token: host.ownershipToken,
              publication_id: host.publicationID,
              publication_write_token: host.ownershipToken,
              updated_at: host.updatedAt,
            })
          : update
              .doUpdateSet({
                owner: host.owner,
                name: host.name,
                address: host.address,
                port: host.port,
                updated_at: host.updatedAt,
              })
              .where("desktop_hosts.ownership_token", "=", "");
      })
      .returningAll()
      .executeTakeFirst();
    if (!row) throw desktopHostOwnershipConflict();
    return {
      quicPort: row.quic_port ?? null,
      quicCertHash: row.quic_cert_hash ?? null,
      webtransport: row.webtransport === 1,
      ownerSubject: row.owner_subject,
      id: row.id,
      owner: row.owner,
      name: row.name,
      address: row.address,
      port: row.port,
      ownershipToken: row.ownership_token,
      publicationID: row.publication_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async ownershipTokenForPublication(
    ownerSubject: string,
    id: string,
    publicationID: string,
  ): Promise<string | null> {
    const row = await database(this.env)
      .selectFrom("desktop_hosts")
      .select("ownership_token")
      .where("owner_subject", "=", ownerSubject)
      .where("id", "=", id)
      .where("publication_id", "=", publicationID)
      .where("ownership_token", "<>", "")
      .executeTakeFirst();
    return row?.ownership_token ?? null;
  }

  async remove(ownerSubject: string, id: string, ownershipToken: string | null): Promise<void> {
    const db = database(this.env);
    if (!ownershipToken) {
      const deleted = await db
        .deleteFrom("desktop_hosts")
        .where("owner_subject", "=", ownerSubject)
        .where("id", "=", id)
        .where("ownership_token", "=", "")
        .executeTakeFirst();
      if ((deleted.numDeletedRows ?? 0n) > 0n) return;
      const existing = await db
        .selectFrom("desktop_hosts")
        .select("ownership_token")
        .where("owner_subject", "=", ownerSubject)
        .where("id", "=", id)
        .executeTakeFirst();
      if (existing?.ownership_token) throw desktopHostOwnershipConflict();
      return;
    }
    const deleteMarker = `delete-authorized:${crypto.randomUUID()}`;
    // The migration trigger permits this marker only; the atomic batch keeps it
    // invisible to legacy workers between authorization and deletion.
    await executeBatch(this.env, [
      db
        .updateTable("desktop_hosts")
        .set({ ownership_token: deleteMarker })
        .where("owner_subject", "=", ownerSubject)
        .where("id", "=", id)
        .where("ownership_token", "=", ownershipToken),
      db
        .deleteFrom("desktop_hosts")
        .where("owner_subject", "=", ownerSubject)
        .where("id", "=", id)
        .where("ownership_token", "=", deleteMarker),
    ]);
  }
}

function desktopHostOwnershipConflict(): ReturnType<typeof conflict> {
  return conflict("desktop host is owned by a token-aware registration");
}
