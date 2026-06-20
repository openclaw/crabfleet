import {
  openClawBranchPreparationCanDefer,
  openClawGitBranchAllowed,
} from "../openclaw-service.ts";
import { GitHubApiError } from "./github.ts";
import { badRequest, serviceUnavailable } from "./http.ts";
import type { InteractiveSession } from "./session-model.ts";
import type { ResolvedGrantPrincipal } from "./session-grant-repository.ts";
import {
  openClawCrabboxRequestHash,
  openClawRequestId,
  type OpenClawCrabboxRequest,
  type OpenClawReplayCompatibility,
} from "./openclaw-request.ts";
import { normalizeRepo } from "./repositories.ts";

export type OpenClawCreateInput = OpenClawCrabboxRequest & {
  owner?: unknown;
  requestId?: unknown;
};

export type OpenClawCreateSessionOptions = {
  owner: string;
  ownerSubject: string;
  createdBy: "service:openclaw";
  openClawRequestId: string | null;
  openClawRequestHash: string | null;
  openClawReplayCompatibility: OpenClawReplayCompatibility;
  afterReserve(): Promise<void>;
};

export type OpenClawCreateStore = {
  defaultRuntime: "crabbox" | "container";
  privateTenancy: boolean;
  now(): number;
  preparationSignal(): AbortSignal;
  readRequestSession(
    requestId: string,
    requestHash: string,
    compatibility: OpenClawReplayCompatibility,
  ): Promise<InteractiveSession | null>;
  resolvePrincipal(value: string): Promise<ResolvedGrantPrincipal | null>;
  prepareBranch(
    repo: unknown,
    branch: unknown,
    baseBranch: unknown,
    signal: AbortSignal,
  ): Promise<void>;
  createSession(
    body: OpenClawCrabboxRequest,
    githubToken: string | undefined,
    options: OpenClawCreateSessionOptions,
  ): Promise<InteractiveSession>;
  audit(message: string, now: number): Promise<void>;
  warn(event: Record<string, unknown>): void;
};

export class OpenClawCreateService {
  private readonly store: OpenClawCreateStore;

  constructor(store: OpenClawCreateStore) {
    this.store = store;
  }

  async create(input: OpenClawCreateInput): Promise<InteractiveSession> {
    const owner = openClawOwner(input.owner);
    const ownerInput = clean(input.owner, 240);
    const ownerIdentity =
      (await this.store.resolvePrincipal(ownerInput)) ||
      (ownerInput !== owner ? await this.store.resolvePrincipal(owner) : null);
    if (!ownerIdentity && this.store.privateTenancy) {
      throw badRequest("owner must identify one active Crabfleet user in private tenancy");
    }
    const body: OpenClawCrabboxRequest = {
      ...input,
      branch: openClawServiceBranch(input.branch, "branch", "main"),
    };
    const baseBranch = openClawServiceBranch(input.baseBranch, "baseBranch");
    if (baseBranch) body.baseBranch = baseBranch;
    else delete body.baseBranch;

    const requestId = openClawRequestId(input.requestId);
    const requestOwnerIdentity = this.store.privateTenancy
      ? (ownerIdentity?.subject ?? owner)
      : owner;
    const requestHash = requestId
      ? await openClawCrabboxRequestHash(body, requestOwnerIdentity, this.store.defaultRuntime)
      : null;
    const replayCompatibility: OpenClawReplayCompatibility = {
      legacyRequest: { body, defaultRuntime: this.store.defaultRuntime },
      expectedOwner: ownerIdentity?.actor ?? owner,
      resolvedOwnerSubject: ownerIdentity?.subject ?? null,
      ownerSubject: this.store.privateTenancy ? (ownerIdentity?.subject ?? null) : null,
    };
    if (requestId && requestHash) {
      const existing = await this.store.readRequestSession(
        requestId,
        requestHash,
        replayCompatibility,
      );
      if (existing) return existing;
    }

    const session = await this.store.createSession(
      body,
      clean(input.githubToken, 4000) || undefined,
      {
        owner: ownerIdentity?.actor ?? owner,
        ownerSubject: ownerIdentity?.subject ?? "",
        createdBy: "service:openclaw",
        openClawRequestId: requestId,
        openClawRequestHash: requestHash,
        openClawReplayCompatibility: replayCompatibility,
        afterReserve: () => this.prepareBranch(body),
      },
    );
    await this.store.audit(
      `openclaw crabbox created ${session.id} owner=${owner}`,
      this.store.now(),
    );
    return session;
  }

  private async prepareBranch(body: OpenClawCrabboxRequest): Promise<void> {
    const signal = this.store.preparationSignal();
    try {
      await this.store.prepareBranch(body.repo, body.branch, body.baseBranch, signal);
    } catch (error) {
      if (signal.aborted) {
        throw serviceUnavailable("OpenClaw branch preparation timed out");
      }
      if (!(error instanceof GitHubApiError) || !openClawBranchPreparationCanDefer(error.status)) {
        throw error;
      }
      this.store.warn({
        event: "openclaw_branch_preparation_deferred",
        repo: normalizeRepo(body.repo),
        branch: clean(body.branch, 120) || "main",
        status: error.status,
      });
    }
  }
}

export function openClawServiceBranch(value: unknown, name: string, fallback = ""): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !openClawGitBranchAllowed(value)) {
    throw badRequest(`${name} must be a valid Git branch of at most 120 characters`);
  }
  return value;
}

export function openClawOwner(value: unknown): string {
  const owner = clean(value, 240);
  if (!owner) throw badRequest("owner is required");
  if (/^[A-Za-z0-9_.-]+$/.test(owner)) return owner;
  if (/^@[A-Za-z0-9_.-]+$/.test(owner)) return owner.slice(1);
  if (/^github:[A-Za-z0-9_.-]+$/.test(owner)) return owner.replace(/^github:/, "");
  return owner;
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
