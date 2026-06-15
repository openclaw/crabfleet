import { notFound } from "./http.ts";
import type { InteractiveSession } from "./session-model.ts";
import type { InteractiveSessionShareCredential } from "./session-repository.ts";
import { sharedInteractiveSession } from "./session-sharing.ts";

export type SharedSessionServiceStore = {
  now(): number;
  readCredential(sessionId: string): Promise<InteractiveSessionShareCredential | null>;
  hashToken(token: string): Promise<string>;
  isEmbedToken(sessionId: string, token: string): Promise<boolean>;
  terminalRouteAvailable(session: InteractiveSession): boolean;
};

export class SharedSessionService {
  private readonly store: SharedSessionServiceStore;

  constructor(store: SharedSessionServiceStore) {
    this.store = store;
  }

  async read(sessionId: string, token: string): Promise<{ session: InteractiveSession }> {
    const credential = await this.store.readCredential(sessionId);
    const embedded = await this.store.isEmbedToken(sessionId, token);
    const shared =
      credential?.session.shareMode === "link_read" &&
      Boolean(credential.tokenHash) &&
      Boolean(token) &&
      (await this.store.hashToken(token)) === credential.tokenHash;
    if (!credential || (!embedded && !shared)) {
      throw notFound("shared session not found");
    }
    return {
      session: sharedInteractiveSession(credential.session, this.store.now(), {
        canControl: embedded,
        terminalRouteAvailable: this.store.terminalRouteAvailable(credential.session),
      }),
    };
  }
}
