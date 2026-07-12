import type { GitHubActionsSessionRegistrationInput } from "./github-actions-session-registration.ts";
import { AdminRepository } from "./admin-repository.ts";
import {
  GitHubActionsSessionRegistrationService,
  type GitHubActionsSessionRegistrationStore,
} from "./github-actions-session-registration.ts";
import {
  GitHubActionsRunnerConnectionService,
  type GitHubActionsRunnerConnectionStore,
} from "./github-actions-runner-connection.ts";
import { GitHubActionsRepository } from "./github-actions-repository.ts";
import {
  GitHubActionsWorkStateService,
  type GitHubActionsWorkStateInput,
  type GitHubActionsWorkStateStore,
} from "./github-actions-session-work-state.ts";
import { actor } from "./auth.ts";
import { sha256 } from "./crypto.ts";
import type { RuntimeEnv } from "./env.ts";
import { badRequest, readBoundedJson, readJson, serviceUnavailable } from "./http.ts";
import type { User } from "./models.ts";
import {
  AgentSessionAuthenticator,
  agentSessionId,
  type AgentSessionAuthenticationOptions,
  type AgentSessionAuthenticationStore,
} from "./session-agent-auth.ts";
import {
  appendInteractiveSessionEventRecord,
  appendStructuredInteractiveSessionEventRecord,
} from "./session-events.ts";
import { InteractiveSessionGrantRepository } from "./session-grant-repository.ts";
import { nextInteractiveSessionId } from "./session-id-repository.ts";
import type { InteractiveSession } from "./session-model.ts";
import { readAgentSessionCredential, readInteractiveSessionRecord } from "./session-repository.ts";
import { newAgentToken } from "./session-reservation-context.ts";
import { githubActionsRelayStub } from "./github-actions-relay.ts";
import { ServiceRegistry } from "./service-registry.ts";

const services = {
  adminRepository: Symbol("admin-repository"),
  authenticator: Symbol("authenticator"),
  repository: Symbol("repository"),
};

export const structuredEventRequestMaxBytes = 96 * 1024;

export type GitHubActionsApplicationDependencies = {
  audit(user: User, message: string, now: number): Promise<void>;
};

export class GitHubActionsApplication {
  private readonly env: RuntimeEnv;
  private readonly dependencies: GitHubActionsApplicationDependencies;
  private readonly registry = new ServiceRegistry();

  constructor(env: RuntimeEnv, dependencies: GitHubActionsApplicationDependencies) {
    this.env = env;
    this.dependencies = dependencies;
  }

  isAgentRequest(request: Request): boolean {
    return Boolean(agentSessionId(request));
  }

  authenticate(
    request: Request,
    expectedId?: string,
    options: AgentSessionAuthenticationOptions = {},
  ): Promise<{ session: InteractiveSession; user: User }> {
    return this.authenticator().require(request, expectedId, options);
  }

  async register(input: GitHubActionsSessionRegistrationInput, user: User) {
    const repository = this.repository();
    const store: GitHubActionsSessionRegistrationStore = {
      now: () => Date.now(),
      newAgentToken,
      hashToken: sha256,
      requireRepo: (repo) => this.adminRepository().requireRepo(repo),
      resolvePrincipal: (value) =>
        new InteractiveSessionGrantRepository(this.env).resolvePrincipal(value),
      readByWorkKey: (workKey) => repository.readByWorkKey(workKey),
      nextSessionId: () => nextInteractiveSessionId(this.env),
      insertSession: (values) => repository.insertSession(values),
      readById: (id) => repository.readById(id),
      updateSession: (id, values, expected) => repository.updateSession(id, values, expected),
      isConstraintError,
      disconnectRunner: (id) => this.disconnectRunner(id),
      appendEvent: (id, message, now) => this.appendMessageEvent(id, user, message, now),
      audit: (message, now) => this.dependencies.audit(user, message, now),
      readSession: (id) => readInteractiveSessionRecord(this.env, id),
    };
    return new GitHubActionsSessionRegistrationService(store).register(input);
  }

  async updateWorkState(
    request: Request,
    id: string,
  ): Promise<{ session: InteractiveSession; user: User }> {
    const { session, user } = await this.authenticate(request, id);
    const body = await readJson<GitHubActionsWorkStateInput>(request);
    const repository = this.repository();
    const store: GitHubActionsWorkStateStore = {
      now: () => Date.now(),
      readRow: (sessionId) => repository.readById(sessionId),
      persist: (sessionId, values, expectedTerminalStatus) =>
        repository.updateSession(sessionId, values, undefined, expectedTerminalStatus),
      appendEvent: (sessionId, message, now) =>
        this.appendMessageEvent(sessionId, user, message, now),
      disconnectRunner: (sessionId) => this.disconnectRunner(sessionId),
      readSession: (sessionId) => readInteractiveSessionRecord(this.env, sessionId),
    };
    return {
      session: await new GitHubActionsWorkStateService(store).update(session, body),
      user,
    };
  }

  async appendStructuredEvent(request: Request, id: string) {
    const { user } = await this.authenticate(request, id, { allowTerminalEventReplay: true });
    const input = await readBoundedJson<unknown>(request, structuredEventRequestMaxBytes);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw badRequest("event body must be a JSON object");
    }
    const body = input as {
      eventKey?: unknown;
      type?: unknown;
      message?: unknown;
      payload?: unknown;
    };
    return appendStructuredInteractiveSessionEventRecord(this.env, {
      sessionId: id,
      actor: actor(user),
      eventKey: body.eventKey,
      type: body.type,
      message: body.message,
      payload: body.payload,
      now: Date.now(),
    });
  }

  async openRunnerPty(request: Request, id: string): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw badRequest("websocket upgrade required");
    }
    const { session, user } = await this.authenticate(request, id, {
      allowQueryToken: true,
    });
    const stub = githubActionsRelayStub(this.env, id);
    if (!stub) throw serviceUnavailable("SESSION_CONTROL Durable Object is not configured");
    const repository = this.repository();
    const store: GitHubActionsRunnerConnectionStore = {
      now: () => Date.now(),
      persist: (sessionId, values) => repository.updateSession(sessionId, values),
      appendEvent: (sessionId, message, now) =>
        this.appendMessageEvent(sessionId, user, message, now),
    };
    await new GitHubActionsRunnerConnectionService(store).connect(session);
    return stub.fetch("https://crabfleet.internal/api/session-control/github-actions/runner", {
      headers: { upgrade: "websocket" },
    });
  }

  async disconnectRunner(id: string): Promise<void> {
    const stub = githubActionsRelayStub(this.env, id);
    if (!stub) return;
    const response = await stub.fetch(
      "https://crabfleet.internal/api/session-control/github-actions/disconnect-runner",
      { method: "POST" },
    );
    if (!response.ok) throw serviceUnavailable("GitHub Actions relay is unavailable");
  }

  private authenticator(): AgentSessionAuthenticator {
    return this.registry.get(
      services.authenticator,
      () =>
        new AgentSessionAuthenticator({
          readCredential: (id) => readAgentSessionCredential(this.env, id),
          hashToken: sha256,
        } satisfies AgentSessionAuthenticationStore),
    );
  }

  private adminRepository(): AdminRepository {
    return this.registry.get(services.adminRepository, () => new AdminRepository(this.env));
  }

  private repository(): GitHubActionsRepository {
    return this.registry.get(services.repository, () => new GitHubActionsRepository(this.env));
  }

  private appendMessageEvent(id: string, user: User, message: string, now: number): Promise<void> {
    return appendInteractiveSessionEventRecord(this.env, {
      sessionId: id,
      actor: actor(user),
      message,
      now,
    });
  }
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique/i.test(error.message);
}
