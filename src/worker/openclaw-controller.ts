import type {
  GitHubActionsSessionRegistration,
  GitHubActionsSessionRegistrationInput,
} from "./github-actions-session-registration.ts";
import { openClawEmbedTicketTtlSeconds } from "../openclaw-service.ts";
import { badRequest } from "./http.ts";
import type { OpenClawCreateInput } from "./openclaw-create.ts";
import {
  buildOpenClawTranscript,
  openClawSessionSummary,
  openClawTranscriptEventWindow,
  openClawVisibleRoomSessions,
  type OpenClawRoomRead,
} from "./openclaw-queries.ts";
import type { OpenClawRootStopResult } from "./openclaw-root-stop.ts";
import { sessionLogTranscript } from "./session-log-archive.ts";
import type { InteractiveSession, InteractiveSessionEventRow } from "./session-model.ts";

export type OpenClawCrabboxResponse = {
  session: InteractiveSession;
  browserUrl: string;
};

export type OpenClawMessageInput = {
  message?: unknown;
  enter?: unknown;
};

export type OpenClawEmbedTicketInput = {
  ttlSeconds?: unknown;
};

export type OpenClawControllerStore = {
  createCrabbox(input: OpenClawCreateInput): Promise<InteractiveSession>;
  readRoomRoot(rootSessionId: string): Promise<InteractiveSession | null>;
  readRoomSessions(rootSessionId: string): Promise<OpenClawRoomRead>;
  stopSessionRoot(request: Request, rootSessionId: string): Promise<OpenClawRootStopResult>;
  requireRootScopedSession(sessionId: string, rootSessionId: string): Promise<InteractiveSession>;
  readTranscriptEvents(
    sessionId: string,
    maximumEvents: number,
  ): Promise<InteractiveSessionEventRow[]>;
  countTranscriptEvents(sessionId: string): Promise<number>;
  sendMessage(
    request: Request,
    session: InteractiveSession,
    input: OpenClawMessageInput,
  ): Promise<void>;
  stopSession(request: Request, session: InteractiveSession): Promise<InteractiveSession>;
  registerActionSession(
    input: GitHubActionsSessionRegistrationInput,
  ): Promise<GitHubActionsSessionRegistration>;
  now(): number;
  createEmbedTicket(sessionId: string, expiresAt: number): Promise<string>;
  decorateSession(session: InteractiveSession): InteractiveSession;
  browserUrl(sessionId: string): string;
  browserEmbedUrl(sessionId: string, token: string): string;
  runnerPtyUrl(sessionId: string, agentToken: string): string;
};

export class OpenClawController {
  private readonly store: OpenClawControllerStore;

  constructor(store: OpenClawControllerStore) {
    this.store = store;
  }

  async createCrabbox(input: OpenClawCreateInput): Promise<OpenClawCrabboxResponse> {
    const session = await this.store.createCrabbox(input);
    return this.crabboxResponse(session);
  }

  async readSessionRoot(rootSessionId: string): Promise<{
    rootSessionId: string;
    crabboxes: OpenClawCrabboxResponse[];
  }> {
    const root = requiredIdentifier(rootSessionId, "root session id");
    const [rootSession, room] = await Promise.all([
      this.store.readRoomRoot(root),
      this.store.readRoomSessions(root),
    ]);
    const sessions = openClawVisibleRoomSessions(root, rootSession, room);
    return {
      rootSessionId: root,
      crabboxes: sessions.map((session) => this.crabboxSummaryResponse(session)),
    };
  }

  async stopSessionRoot(
    request: Request,
    rootSessionId: string,
  ): Promise<{
    rootSessionId: string;
    admissionClosed: true;
    crabboxes: OpenClawCrabboxResponse[];
  }> {
    const root = requiredIdentifier(rootSessionId, "root session id");
    const result = await this.store.stopSessionRoot(request, root);
    return {
      rootSessionId: result.rootSessionId,
      admissionClosed: true,
      crabboxes: result.sessions.map((session) => this.crabboxSummaryResponse(session)),
    };
  }

  async readCrabbox(sessionId: string, rootSessionId: string): Promise<OpenClawCrabboxResponse> {
    const session = await this.rootScopedSession(sessionId, rootSessionId);
    return this.crabboxSummaryResponse(session);
  }

  async readCrabboxTranscript(
    sessionId: string,
    rootSessionId: string,
  ): Promise<
    OpenClawCrabboxResponse & {
      transcript: string;
      eventCount: number;
      truncated: boolean;
    }
  > {
    const session = await this.rootScopedSession(sessionId, rootSessionId);
    const [eventWindow, eventCount] = await Promise.all([
      this.store.readTranscriptEvents(session.id, openClawTranscriptEventWindow),
      this.store.countTranscriptEvents(session.id),
    ]);
    const transcript = buildOpenClawTranscript(eventWindow, eventCount, (events) =>
      sessionLogTranscript(session, events),
    );
    return {
      ...this.crabboxSummaryResponse(session),
      ...transcript,
    };
  }

  async messageCrabbox(
    request: Request,
    sessionId: string,
    rootSessionId: string,
    input: OpenClawMessageInput,
  ): Promise<OpenClawCrabboxResponse & { delivered: true }> {
    const session = await this.rootScopedSession(sessionId, rootSessionId);
    await this.store.sendMessage(request, session, input);
    return {
      delivered: true,
      ...this.crabboxSummaryResponse(session),
    };
  }

  async stopCrabbox(
    request: Request,
    sessionId: string,
    rootSessionId: string,
  ): Promise<OpenClawCrabboxResponse> {
    const current = await this.rootScopedSession(sessionId, rootSessionId);
    const stopped = await this.store.stopSession(request, current);
    return this.crabboxSummaryResponse(stopped);
  }

  async createCrabboxEmbedTicket(
    sessionId: string,
    rootSessionId: string,
    input: OpenClawEmbedTicketInput,
  ): Promise<{ browserUrl: string; expiresAt: number }> {
    if (
      input.ttlSeconds !== undefined &&
      (typeof input.ttlSeconds !== "number" || !Number.isFinite(input.ttlSeconds))
    ) {
      throw badRequest("ttlSeconds must be a finite number");
    }
    const session = await this.rootScopedSession(sessionId, rootSessionId);
    if (["stopping", "stopped", "expired", "failed"].includes(session.status)) {
      throw badRequest(`session is ${session.status}`);
    }
    if (!session.capabilities.terminal) {
      throw badRequest("session does not advertise terminal access");
    }
    const expiresAt = this.store.now() + openClawEmbedTicketTtlSeconds(input.ttlSeconds) * 1000;
    const token = await this.store.createEmbedTicket(session.id, expiresAt);
    return {
      browserUrl: this.store.browserEmbedUrl(session.id, token),
      expiresAt,
    };
  }

  async registerActionSession(input: GitHubActionsSessionRegistrationInput): Promise<{
    session: InteractiveSession;
    agentToken: string;
    runnerPtyUrl: string;
    browserUrl: string;
  }> {
    const result = await this.store.registerActionSession(input);
    return {
      session: this.store.decorateSession(result.session),
      agentToken: result.agentToken,
      runnerPtyUrl: this.store.runnerPtyUrl(result.session.id, result.agentToken),
      browserUrl: this.store.browserUrl(result.session.id),
    };
  }

  private async rootScopedSession(
    sessionId: string,
    rootSessionId: string,
  ): Promise<InteractiveSession> {
    return this.store.requireRootScopedSession(
      requiredIdentifier(sessionId, "session id"),
      requiredIdentifier(rootSessionId, "root session id"),
    );
  }

  private crabboxSummaryResponse(session: InteractiveSession): OpenClawCrabboxResponse {
    const response = this.crabboxResponse(this.store.decorateSession(session));
    return { ...response, session: openClawSessionSummary(response.session) };
  }

  private crabboxResponse(session: InteractiveSession): OpenClawCrabboxResponse {
    return {
      session,
      browserUrl: this.store.browserUrl(session.id),
    };
  }
}

function requiredIdentifier(value: unknown, name: string): string {
  const identifier = String(value ?? "")
    .trim()
    .slice(0, 120);
  if (!identifier) throw badRequest(`${name} is required`);
  return identifier;
}
