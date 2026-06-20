import { actor } from "./auth.ts";
import { userServiceSessionAuthority, type User } from "./models.ts";
import { isSandboxInteractiveSession } from "./sandbox-lease.ts";
import {
  interactiveSessionControllerSubject,
  interactiveSessionOwnerSubject,
  type InteractiveSession,
} from "./session-model.ts";
import { sessionOwnerSubject, tenantSubject, type TenancyMode } from "./tenancy.ts";

export type InteractiveSessionGrantRole = "viewer" | "controller";

export type InteractiveSessionAccessGrant = {
  subject: string;
  role: InteractiveSessionGrantRole;
  expiresAt: number | null;
};

export type InteractiveSessionAccessContext = {
  mode?: TenancyMode;
  grant?: InteractiveSessionAccessGrant | null;
};

export type InteractiveSessionAccess = {
  visible: boolean;
  manage: boolean;
  control: boolean;
  changeMultiplayer: boolean;
  role: "owner" | InteractiveSessionGrantRole | null;
};

export function canChangeInteractiveSessionMultiplayer(
  user: User,
  session: InteractiveSession,
  context: InteractiveSessionAccessContext = {},
): boolean {
  return interactiveSessionAccess(user, session, Date.now(), true, context).changeMultiplayer;
}

export function canViewInteractiveSession(
  user: User,
  session: InteractiveSession,
  now: number,
  context: InteractiveSessionAccessContext = {},
): boolean {
  return interactiveSessionAccess(user, session, now, true, context).visible;
}

export function canManageInteractiveSession(
  user: User,
  session: InteractiveSession,
  context: InteractiveSessionAccessContext = {},
): boolean {
  return interactiveSessionAccess(user, session, Date.now(), true, context).manage;
}

export function canControlInteractiveSession(
  user: User,
  session: InteractiveSession,
  now: number,
  delegatedControl = true,
  context: InteractiveSessionAccessContext = {},
): boolean {
  return interactiveSessionAccess(user, session, now, delegatedControl, context).control;
}

export function canReadInteractiveSessionTerminal(
  user: User,
  session: InteractiveSession,
  now: number,
  delegatedControl = true,
  context: InteractiveSessionAccessContext = {},
): boolean {
  return (
    Boolean(activeInteractiveSessionGrant(user, context.grant, now)) ||
    interactiveSessionAccess(user, session, now, delegatedControl, context).control
  );
}

export function interactiveSessionAccess(
  user: User,
  session: InteractiveSession,
  now: number,
  delegatedControl = true,
  context: InteractiveSessionAccessContext = {},
): InteractiveSessionAccess {
  const mode = context.mode ?? "shared";
  const owner = ownsInteractiveSession(user, session, mode);
  const sessionAuthority = user[userServiceSessionAuthority];
  const serviceCreator =
    (user.subject.startsWith("service:") && session.createdBy === user.subject) ||
    (Boolean(sessionAuthority) &&
      (session.id === sessionAuthority ||
        (session.parentSessionId === sessionAuthority &&
          session.createdBy === `session:${sessionAuthority}`)));
  const grant = activeInteractiveSessionGrant(user, context.grant, now);
  const delegated =
    delegatedControl &&
    typeof session.controlExpiresAt === "number" &&
    session.controlExpiresAt > now &&
    (session[interactiveSessionControllerSubject]
      ? session[interactiveSessionControllerSubject] === tenantSubject(user)
      : mode === "shared" && session.controller === actor(user));

  if (mode === "shared") {
    const manage = owner || serviceCreator || user.role === "maintainer" || user.role === "owner";
    const control = manage || grant?.role === "controller" || delegated;
    return {
      visible: true,
      manage,
      control,
      changeMultiplayer: owner,
      role: owner || serviceCreator ? "owner" : control ? "controller" : "viewer",
    };
  }

  const manage = owner || serviceCreator;
  const control = manage || grant?.role === "controller" || delegated;
  return {
    visible: manage || Boolean(grant) || delegated,
    manage,
    control,
    changeMultiplayer: owner,
    role: manage ? "owner" : control ? "controller" : grant?.role === "viewer" ? "viewer" : null,
  };
}

export function delegatedInteractiveSessionControlAvailable(
  sandboxAvailable: boolean,
  session: InteractiveSession,
): boolean {
  return sandboxAvailable || !isSandboxInteractiveSession(session);
}

export function interactiveSessionActorCandidates(user: User): Set<string> {
  return new Set(
    [actor(user), user.subject, user.login, user.email].filter((value): value is string =>
      Boolean(value),
    ),
  );
}

export function ownsInteractiveSession(
  user: User,
  session: InteractiveSession,
  mode: TenancyMode = "shared",
): boolean {
  const ownerSubject = session[interactiveSessionOwnerSubject];
  return ownerSubject
    ? ownerSubject === sessionOwnerSubject(user)
    : mode === "shared" && interactiveSessionActorCandidates(user).has(session.owner);
}

export function activeInteractiveSessionGrant(
  user: User,
  grant: InteractiveSessionAccessGrant | null | undefined,
  now: number,
): InteractiveSessionAccessGrant | null {
  if (!grant || grant.subject !== tenantSubject(user)) return null;
  return grant.expiresAt === null || grant.expiresAt > now ? grant : null;
}
