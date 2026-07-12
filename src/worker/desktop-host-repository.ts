import { database } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";

export type DesktopHostRow = {
  ownerSubject: string;
  id: string;
  owner: string;
  name: string;
  address: string;
  port: number;
  ownershipToken: string;
  createdAt: number;
  updatedAt: number;
};

export type DesktopHostWrite = DesktopHostRow;

export interface DesktopHostStore {
  list(ownerSubject: string): Promise<DesktopHostRow[]>;
  upsert(host: DesktopHostWrite): Promise<DesktopHostRow>;
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
        created_at: host.createdAt,
        updated_at: host.updatedAt,
      })
      .onConflict((conflict) =>
        conflict.columns(["owner_subject", "id"]).doUpdateSet({
          owner: host.owner,
          name: host.name,
          address: host.address,
          port: host.port,
          ownership_token: host.ownershipToken,
          updated_at: host.updatedAt,
        }),
      )
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async remove(ownerSubject: string, id: string, ownershipToken: string | null): Promise<void> {
    await database(this.env)
      .deleteFrom("desktop_hosts")
      .where("owner_subject", "=", ownerSubject)
      .where("id", "=", id)
      .where("ownership_token", "=", ownershipToken ?? "")
      .execute();
  }
}
