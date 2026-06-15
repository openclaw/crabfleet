import type { UpdateObject } from "kysely";

import { sha256 } from "./crypto.ts";
import type { Database } from "./database.ts";
import { badRequest, conflict, forbidden, notFound } from "./http.ts";
import { deadInteractiveSessionStatuses } from "./models.ts";
import type { InteractiveSession } from "./session-model.ts";

export const interactiveSessionMetadataActions = [
  "share_link",
  "disable_share",
  "enable_multiplayer",
  "disable_multiplayer",
  "request_control",
  "approve_control",
  "deny_control",
  "revoke_control",
] as const;

export type InteractiveSessionMetadataAction = (typeof interactiveSessionMetadataActions)[number];

export type InteractiveSessionMetadataPolicy = {
  canManage: boolean;
  canChangeMultiplayer: boolean;
  canControl: boolean;
  delegatedControlAvailable: boolean;
};

export type InteractiveSessionMetadataMutation = {
  session: InteractiveSession;
  action: InteractiveSessionMetadataAction;
  actor: string;
  policy: InteractiveSessionMetadataPolicy;
  now: number;
};

export type InteractiveSessionMetadataResult = {
  session: InteractiveSession;
  shareToken?: string;
};

export type InteractiveSessionMetadataStore = {
  persist(
    session: Pick<InteractiveSession, "id" | "status" | "updatedAt">,
    actor: string,
    message: string,
    values: UpdateObject<Database, "interactive_sessions">,
    now: number,
  ): Promise<boolean>;
  archive(sessionId: string, now: number): Promise<void>;
  audit(message: string, now: number): Promise<void>;
  readSession(sessionId: string): Promise<InteractiveSession | null>;
};

type ShareTokenFactory = () => string;
type ShareTokenHasher = (token: string) => Promise<string>;

const delegatedControlDurationMs = 30 * 60 * 1000;

export class InteractiveSessionMetadataService {
  private readonly store: InteractiveSessionMetadataStore;
  private readonly createShareToken: ShareTokenFactory;
  private readonly hashShareToken: ShareTokenHasher;

  constructor(
    store: InteractiveSessionMetadataStore,
    createShareToken: ShareTokenFactory = interactiveSessionShareToken,
    hashShareToken: ShareTokenHasher = sha256,
  ) {
    this.store = store;
    this.createShareToken = createShareToken;
    this.hashShareToken = hashShareToken;
  }

  async mutate(
    input: InteractiveSessionMetadataMutation,
  ): Promise<InteractiveSessionMetadataResult> {
    const { action, actor, now, policy, session } = input;

    if (action === "share_link") {
      if (!policy.canManage) {
        throw forbidden("only the session owner or maintainer can share");
      }
      const shareToken = this.createShareToken();
      await this.persist(
        session,
        actor,
        "read-only share link enabled",
        {
          share_mode: "link_read",
          share_token_hash: await this.hashShareToken(shareToken),
          share_token_preview: shareToken.slice(0, 8),
        },
        now,
      );
      await this.store.audit(`interactive session share enabled ${session.id}`, now);
      return { session: await this.readSession(session.id), shareToken };
    }

    if (action === "disable_share") {
      if (!policy.canManage) {
        throw forbidden("only the session owner or maintainer can disable sharing");
      }
      await this.persist(
        session,
        actor,
        "session sharing disabled",
        {
          share_mode: "private",
          share_token_hash: null,
          share_token_preview: null,
          control_requested_by: null,
          control_requested_at: null,
          controller: null,
          control_granted_at: null,
          control_expires_at: null,
        },
        now,
      );
      await this.store.audit(`interactive session share disabled ${session.id}`, now);
      return { session: await this.readSession(session.id) };
    }

    if (action === "enable_multiplayer" || action === "disable_multiplayer") {
      if (!policy.canChangeMultiplayer) {
        throw forbidden("only the session creator can change multiplayer");
      }
      const enabled = action === "enable_multiplayer";
      await this.persist(
        session,
        actor,
        enabled ? "multiplayer mode enabled" : "multiplayer mode disabled",
        { multiplayer_mode: enabled ? 1 : 0 },
        now,
      );
      await this.store.audit(
        `interactive session multiplayer ${enabled ? "enabled" : "disabled"} ${session.id}`,
        now,
      );
      return { session: await this.readSession(session.id) };
    }

    if (action === "request_control") {
      this.requireDelegatedControl(policy);
      if (policy.canControl) return { session };
      if (
        session.status === "stopping" ||
        deadInteractiveSessionStatuses.includes(session.status)
      ) {
        throw badRequest(`session is ${session.status}`);
      }
      await this.persist(
        session,
        actor,
        `${actor} requested terminal control`,
        {
          control_requested_by: actor,
          control_requested_at: now,
        },
        now,
      );
      return { session: await this.readSession(session.id) };
    }

    if (action === "approve_control") {
      if (!policy.canManage) {
        throw forbidden("only the session owner or maintainer can approve control");
      }
      if (!session.controlRequestedBy) throw badRequest("no pending control request");
      this.requireDelegatedControl(policy);
      await this.persist(
        session,
        actor,
        `control granted to ${session.controlRequestedBy}`,
        {
          controller: session.controlRequestedBy,
          control_granted_at: now,
          control_expires_at: now + delegatedControlDurationMs,
          control_requested_by: null,
          control_requested_at: null,
        },
        now,
      );
      await this.store.audit(
        `interactive session control granted ${session.id} to ${session.controlRequestedBy}`,
        now,
      );
      return { session: await this.readSession(session.id) };
    }

    if (action === "deny_control") {
      if (!policy.canManage) {
        throw forbidden("only the session owner or maintainer can deny control");
      }
      await this.persist(
        session,
        actor,
        session.controlRequestedBy
          ? `control request denied for ${session.controlRequestedBy}`
          : "control request denied",
        {
          control_requested_by: null,
          control_requested_at: null,
        },
        now,
      );
      return { session: await this.readSession(session.id) };
    }

    if (!policy.canManage) {
      throw forbidden("only the session owner or maintainer can revoke control");
    }
    await this.persist(
      session,
      actor,
      "terminal control revoked",
      {
        controller: null,
        control_granted_at: null,
        control_expires_at: null,
      },
      now,
    );
    await this.store.audit(`interactive session control revoked ${session.id}`, now);
    return { session: await this.readSession(session.id) };
  }

  private requireDelegatedControl(policy: InteractiveSessionMetadataPolicy): void {
    if (!policy.delegatedControlAvailable) {
      throw badRequest("delegated terminal control requires a revocable live terminal");
    }
  }

  private async persist(
    session: Pick<InteractiveSession, "id" | "status" | "updatedAt">,
    actor: string,
    message: string,
    values: UpdateObject<Database, "interactive_sessions">,
    now: number,
  ): Promise<void> {
    if (!(await this.store.persist(session, actor, message, values, now))) {
      throw conflict("interactive session lifecycle changed; retry metadata update");
    }
    await this.store.archive(session.id, now).catch(() => undefined);
  }

  private async readSession(sessionId: string): Promise<InteractiveSession> {
    const session = await this.store.readSession(sessionId);
    if (!session) throw notFound("interactive session not found");
    return session;
  }
}

export function isInteractiveSessionMetadataAction(
  action: string,
): action is InteractiveSessionMetadataAction {
  return interactiveSessionMetadataActions.includes(action as InteractiveSessionMetadataAction);
}

export function interactiveSessionShareToken(): string {
  const first = crypto.randomUUID().replaceAll("-", "");
  const second = crypto.randomUUID().replaceAll("-", "");
  return `${first}${second}`;
}
