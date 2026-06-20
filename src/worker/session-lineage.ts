import { badRequest, notFound } from "./http.ts";
import type { User } from "./models.ts";
import type { InteractiveSession } from "./session-model.ts";

export type InteractiveSessionLineage = {
  parentSessionId: string | null;
  rootSessionId: string | null;
};

export type InteractiveSessionLineageStore = {
  readSession(id: string): Promise<InteractiveSession | null>;
  canManage(user: User, session: InteractiveSession): boolean;
};

export class InteractiveSessionLineageService {
  private readonly store: InteractiveSessionLineageStore;

  constructor(store: InteractiveSessionLineageStore) {
    this.store = store;
  }

  async resolve(
    user: User,
    parentSessionId: string | null,
    rootSessionId: string | null,
  ): Promise<InteractiveSessionLineage> {
    const parentId = clean(parentSessionId, 120) || null;
    const rootId = clean(rootSessionId, 120) || null;
    if (!parentId) {
      if (rootId) throw badRequest("root session id requires a parent session id");
      return { parentSessionId: null, rootSessionId: null };
    }

    const parent = await this.store.readSession(parentId);
    if (!parent || !this.store.canManage(user, parent)) {
      throw notFound("parent session not found");
    }
    return {
      parentSessionId: parent.id,
      rootSessionId: parent.rootSessionId || parent.id,
    };
  }
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
