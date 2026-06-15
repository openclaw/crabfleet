import { actor } from "./auth.ts";
import type { User } from "./models.ts";
import { isSandboxInteractiveSession } from "./sandbox-lease.ts";
import type { InteractiveSession } from "./session-model.ts";

export function canChangeInteractiveSessionMultiplayer(
  user: User,
  session: InteractiveSession,
): boolean {
  return interactiveSessionActorCandidates(user).has(session.owner);
}

export function canManageInteractiveSession(user: User, session: InteractiveSession): boolean {
  return (
    interactiveSessionActorCandidates(user).has(session.owner) ||
    user.role === "maintainer" ||
    user.role === "owner"
  );
}

export function canControlInteractiveSession(
  user: User,
  session: InteractiveSession,
  now: number,
  delegatedControl = true,
): boolean {
  if (canManageInteractiveSession(user, session)) return true;
  if (!delegatedControl) return false;
  return (
    session.controller === actor(user) &&
    typeof session.controlExpiresAt === "number" &&
    session.controlExpiresAt > now
  );
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
