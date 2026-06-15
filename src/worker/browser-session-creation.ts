import type { User } from "./models.ts";
import type { InteractiveSessionCreateRequest } from "./session-create-request.ts";
import type { InteractiveSession } from "./session-model.ts";
import { forbidden, readJson } from "./http.ts";

export type BrowserSessionCreationStore = {
  readGitHubToken(request: Request, user: User): Promise<string | undefined>;
  createSession(
    user: User,
    input: InteractiveSessionCreateRequest,
    githubToken?: string,
  ): Promise<InteractiveSession>;
};

export class BrowserSessionCreationService {
  private readonly store: BrowserSessionCreationStore;

  constructor(store: BrowserSessionCreationStore) {
    this.store = store;
  }

  async create(request: Request, user: User): Promise<{ session: InteractiveSession }> {
    const input = await readJson<InteractiveSessionCreateRequest>(request);
    const requiresGitHubToken = user.subject.startsWith("github:");
    const githubToken = requiresGitHubToken
      ? await this.store.readGitHubToken(request, user)
      : undefined;
    if (requiresGitHubToken && !githubToken) {
      throw forbidden("GitHub PR credentials are not connected; sign in with GitHub again");
    }
    return {
      session: await this.store.createSession(user, input, githubToken),
    };
  }
}
