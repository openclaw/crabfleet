import { actor, requireRole } from "../auth.ts";
import { AdminRepository } from "../admin-repository.ts";
import { AdminService, type AdminAllowEntryInput } from "../admin-service.ts";
import { database } from "../database.ts";
import type { RuntimeEnv } from "../env.ts";
import { badRequest, json, readBoundedJson } from "../http.ts";
import type { User } from "../models.ts";

export async function handleAccessRoute(
  request: Request,
  url: URL,
  user: User,
  env: RuntimeEnv,
): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/admin\/allow(?:\/(.+))?$/u);
  if (!match) return null;
  requireRole(user, "owner");
  const store = new AdminRepository(env);
  const service = new AdminService({
    store,
    now: Date.now,
    audit: async (who, message, now) => {
      await database(env)
        .insertInto("audit_events")
        .values({ actor: actor(who), message, created_at: now })
        .execute();
    },
  });
  if (request.method === "GET" && !match[1]) return json({ allow: await store.readAllowEntries() });
  if (request.method === "POST" && !match[1]) {
    await service.addAllowEntry(await readBoundedJson<AdminAllowEntryInput>(request, 1024), user);
    return json({ allow: await store.readAllowEntries() }, { status: 201 });
  }
  if (request.method === "DELETE" && match[1]) {
    let value: string;
    try {
      value = decodeURIComponent(match[1]);
    } catch {
      throw badRequest("invalid allowlist entry");
    }
    await service.removeAllowEntry(value, user);
    return json({ allow: await store.readAllowEntries() });
  }
  return null;
}
