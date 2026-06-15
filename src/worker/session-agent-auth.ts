import { deadInteractiveSessionStatuses, type User } from "./models.ts";
import { bearerToken, forbidden, unauthorized } from "./http.ts";
import type { InteractiveSession } from "./session-model.ts";

export type AgentSessionCredential = {
  session: InteractiveSession;
  tokenHash: string | null;
};

export type AgentSessionAuthenticationStore = {
  readCredential(id: string): Promise<AgentSessionCredential | null>;
  hashToken(token: string): Promise<string>;
};

export type AgentSessionAuthenticationOptions = {
  allowQueryToken?: boolean;
};

export class AgentSessionAuthenticator {
  private readonly store: AgentSessionAuthenticationStore;

  constructor(store: AgentSessionAuthenticationStore) {
    this.store = store;
  }

  async require(
    request: Request,
    expectedId?: string,
    options: AgentSessionAuthenticationOptions = {},
  ): Promise<{ session: InteractiveSession; user: User }> {
    const presentedId = agentSessionId(request);
    const normalizedExpectedId = boundedValue(expectedId, 120);
    const id = normalizedExpectedId || presentedId;
    if (normalizedExpectedId && presentedId && presentedId !== normalizedExpectedId) {
      throw unauthorized();
    }

    const token = agentSessionToken(request, options);
    if (!id || !token) throw unauthorized();

    const credential = await this.store.readCredential(id);
    if (!credential?.tokenHash || credential.tokenHash !== (await this.store.hashToken(token))) {
      throw unauthorized();
    }
    if (
      credential.session.status === "stopping" ||
      deadInteractiveSessionStatuses.includes(credential.session.status)
    ) {
      throw forbidden("agent session is not active");
    }
    return {
      session: credential.session,
      user: agentSessionUser(credential.session),
    };
  }
}

export function agentSessionId(request: Request): string {
  const url = new URL(request.url);
  return (
    boundedValue(request.headers.get("x-crabfleet-session-id"), 120) ||
    boundedValue(url.searchParams.get("sessionId"), 120)
  );
}

export function agentSessionToken(
  request: Request,
  options: AgentSessionAuthenticationOptions = {},
): string {
  const url = new URL(request.url);
  return (
    bearerToken(request) ||
    boundedValue(request.headers.get("x-crabfleet-agent-token"), 200) ||
    (options.allowQueryToken ? boundedValue(url.searchParams.get("agentToken"), 200) : "")
  );
}

export function agentSessionUser(session: InteractiveSession): User {
  return {
    subject: `agent:${session.id}`,
    login: session.owner,
    email: null,
    name: `Codex ${session.id}`,
    role: "viewer",
    allowed: true,
    teams: [],
  };
}

function boundedValue(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
