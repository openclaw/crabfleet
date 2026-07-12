import { sql } from "kysely";

import { database, executeBatch } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";

export type DesktopHostRow = {
  ownerSubject: string;
  id: string;
  owner: string;
  name: string;
  address: string;
  port: number;
  ownershipToken: string;
  publicationID: string;
  createdAt: number;
  updatedAt: number;
};

export type DesktopHostWrite = DesktopHostRow;

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

export class DesktopHostRepository implements DesktopHostStore {
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

  async upsert(host: DesktopHostWrite): Promise<DesktopHostRow> {
    const row = await database(this.env)
      .insertInto("desktop_hosts")
      .values({
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
              owner: host.owner,
              name: host.name,
              address: host.address,
              port: host.port,
              ownership_token: host.ownershipToken,
              publication_id: host.publicationID,
              publication_write_token: host.ownershipToken,
              updated_at: host.updatedAt,
            })
          : update.doUpdateSet({
              owner: sql<string>`CASE
                WHEN desktop_hosts.ownership_token = '' THEN excluded.owner
                ELSE desktop_hosts.owner
              END`,
              name: sql<string>`CASE
                WHEN desktop_hosts.ownership_token = '' THEN excluded.name
                ELSE desktop_hosts.name
              END`,
              address: sql<string>`CASE
                WHEN desktop_hosts.ownership_token = '' THEN excluded.address
                ELSE desktop_hosts.address
              END`,
              port: sql<number>`CASE
                WHEN desktop_hosts.ownership_token = '' THEN excluded.port
                ELSE desktop_hosts.port
              END`,
              updated_at: sql<number>`CASE
                WHEN desktop_hosts.ownership_token = '' THEN excluded.updated_at
                ELSE desktop_hosts.updated_at
              END`,
            });
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return {
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
      await db
        .deleteFrom("desktop_hosts")
        .where("owner_subject", "=", ownerSubject)
        .where("id", "=", id)
        .where("ownership_token", "=", "")
        .execute();
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
