import { sha256 } from "./crypto.ts";
import { database, type InteractiveSessionRow } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import { badRequest, conflict, serviceUnavailable } from "./http.ts";
import { normalizeRepo } from "./repositories.ts";
import { interactiveSession, type InteractiveSession } from "./session-model.ts";

export type OpenClawCrabboxRequest = {
  repo?: string;
  branch?: string;
  runtime?: string;
  profile?: string;
  command?: string;
  prompt?: string;
  parentSessionId?: string;
  rootSessionId?: string;
  purpose?: string;
  summary?: string;
  baseBranch?: string;
  githubToken?: string;
};

export type OpenClawReplayCompatibility = {
  legacyRequest?: {
    body: OpenClawCrabboxRequest;
    defaultRuntime: "crabbox" | "container";
  } | null;
  expectedOwner?: string | null;
  resolvedOwnerSubject?: string | null;
  ownerSubject?: string | null;
};

export function openClawRequestId(value: unknown): string | null {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string") throw badRequest("requestId must be a string");
  if (value.length > 200) throw badRequest("requestId must be at most 200 characters");
  return value;
}

export async function openClawCrabboxRequestHash(
  body: OpenClawCrabboxRequest,
  ownerIdentity: string,
  defaultRuntime: "crabbox" | "container",
): Promise<string> {
  const githubToken = clean(body.githubToken, 4000);
  const runtime =
    body.runtime === "crabbox" || body.runtime === "container" ? body.runtime : defaultRuntime;
  return sha256(
    JSON.stringify({
      repo: normalizeRepo(body.repo),
      branch: clean(body.branch, 120),
      runtime,
      profile: clean(body.profile, 120),
      command: clean(body.command, 4000),
      prompt: clean(body.prompt, 4000),
      parentSessionId: clean(body.parentSessionId, 120),
      rootSessionId: clean(body.rootSessionId, 120),
      purpose: clean(body.purpose, 500),
      summary: clean(body.summary, 500),
      baseBranch: clean(body.baseBranch, 120),
      githubTokenHash: githubToken ? await sha256(githubToken) : null,
      owner: ownerIdentity,
    }),
  );
}

export async function readOpenClawRequestSession(
  env: RuntimeEnv,
  requestId: string,
  requestHash: string,
  compatibility: OpenClawReplayCompatibility = {},
): Promise<InteractiveSession | null> {
  const replay = await database(env)
    .selectFrom("openclaw_request_replays as replay")
    .leftJoin("interactive_sessions as session", "session.id", "replay.session_id")
    .selectAll("session")
    .select("replay.request_hash as replay_request_hash")
    .where("replay.request_id", "=", requestId)
    .executeTakeFirst();
  if (!replay) return null;
  if (compatibility.ownerSubject && replay.owner_subject !== compatibility.ownerSubject) {
    throw conflict("OpenClaw crabbox request id already belongs to a different owner");
  }
  const compatibleOwner =
    Boolean(compatibility.ownerSubject) ||
    (Boolean(compatibility.expectedOwner) && replay.owner === compatibility.expectedOwner) ||
    (Boolean(compatibility.resolvedOwnerSubject) &&
      replay.owner_subject === compatibility.resolvedOwnerSubject);
  const compatibleRequestHashes = new Set([requestHash]);
  if (compatibility.legacyRequest && compatibleOwner) {
    const ownerIdentities = new Set(
      [
        replay.owner,
        replay.owner_subject,
        compatibility.expectedOwner,
        compatibility.resolvedOwnerSubject,
      ].filter((identity): identity is string => Boolean(identity)),
    );
    for (const ownerIdentity of ownerIdentities) {
      compatibleRequestHashes.add(
        await openClawCrabboxRequestHash(
          compatibility.legacyRequest.body,
          ownerIdentity,
          compatibility.legacyRequest.defaultRuntime,
        ),
      );
    }
  }
  if (!compatibleRequestHashes.has(replay.replay_request_hash)) {
    throw conflict("OpenClaw crabbox request id already belongs to a different request");
  }
  if (!replay.id) {
    throw conflict("OpenClaw crabbox request already completed and is no longer available");
  }
  if (
    replay.created_by !== "service:openclaw" ||
    replay.openclaw_request_id !== requestId ||
    replay.openclaw_request_hash !== replay.replay_request_hash
  ) {
    throw serviceUnavailable("OpenClaw crabbox replay record is inconsistent");
  }
  if (replay.preparation_pending !== 0) {
    throw serviceUnavailable("OpenClaw crabbox request is still preparing");
  }
  return interactiveSession(replay as InteractiveSessionRow, []);
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
