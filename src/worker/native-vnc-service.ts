import { conflict, forbidden, notFound } from "./http.ts";
import type { User } from "./models.ts";
import type { AdapterNativeVNCGrant } from "../runtime-adapter.ts";
import { interactiveSessionAdapterControlPlane, type InteractiveSession } from "./session-model.ts";

// A session must be in one of these live states to mint a native-VNC grant. This mirrors the
// browser-VNC path (InteractiveDesktopService.open), which rejects stopping/stopped/expired/failed
// before minting and re-validates after the round trip. Without the same guard the native path
// hands the caller usable desktop credentials for a workspace that is already being torn down.
const NATIVE_VNC_LIVE_STATUSES = ["ready", "attached", "detached"];

export interface NativeVNCServiceDependencies {
  readSession: (user: User, sessionId: string) => Promise<InteractiveSession | null>;
  mintGrant: (
    profile: string,
    controlPlane: string,
    adapterWorkspaceId: string,
  ) => Promise<AdapterNativeVNCGrant>;
}

/** Mints a native-VNC grant for a live runtime-adapter session, with the same pre-mint status guard
 * and post-mint re-validation as the browser-VNC path. Injected deps keep it unit-testable. */
export class NativeVNCService {
  private readonly dependencies: NativeVNCServiceDependencies;

  constructor(dependencies: NativeVNCServiceDependencies) {
    this.dependencies = dependencies;
  }

  async createGrant(user: User, sessionId: string): Promise<AdapterNativeVNCGrant> {
    const session = await this.dependencies.readSession(user, sessionId);
    if (!session) throw notFound("session not found");
    if (session.canControl !== true) throw forbidden("session control required");
    const controlPlane = session[interactiveSessionAdapterControlPlane];
    if (
      session.runtime !== "crabbox" ||
      session.adapter !== "runtime-v1" ||
      session.capabilities.nativeVnc !== true ||
      !session.adapterWorkspaceId ||
      !controlPlane
    ) {
      throw conflict("native VNC is unavailable for this session");
    }
    // Pre-mint: never mint for a session that is not live (stopping/stopped/expired/failed/…).
    if (!NATIVE_VNC_LIVE_STATUSES.includes(session.status)) {
      throw conflict(`native VNC is unavailable while the session is ${session.status}`);
    }
    const grant = await this.dependencies.mintGrant(
      session.profile,
      controlPlane,
      session.adapterWorkspaceId,
    );
    // Post-mint: re-read and re-validate access the way the browser-VNC sibling's hasCurrentAccess
    // does — control authorization, native-VNC eligibility, and the workspace identity (control-plane,
    // workspace id, provider resource, profile) plus live status — not just status. A concurrent stop,
    // a control revocation, or a re-bind of the workspace during the mint round trip all fail closed.
    // providerResourceId in particular is rewritten by session reconciliation (session-reconciliation.ts)
    // while a session stays live, so pinning it is what stops a grant leaking for a workspace whose
    // backing provider resource moved under us. The one pin the sibling's SQL has that we intentionally
    // omit is adapter_create_pending=0: the InteractiveSession model does not surface that flag, and it
    // is unreachable here anyway — every writer sets it only alongside a provisioning/stopping status,
    // and reconciliation rewrites status and the flag atomically, so a live-status row can never carry it.
    const revalidated = await this.dependencies.readSession(user, sessionId);
    if (
      !revalidated ||
      revalidated.canControl !== true ||
      revalidated.runtime !== "crabbox" ||
      revalidated.adapter !== "runtime-v1" ||
      revalidated.capabilities.nativeVnc !== true ||
      revalidated[interactiveSessionAdapterControlPlane] !== controlPlane ||
      revalidated.adapterWorkspaceId !== session.adapterWorkspaceId ||
      revalidated.providerResourceId !== session.providerResourceId ||
      revalidated.profile !== session.profile ||
      !NATIVE_VNC_LIVE_STATUSES.includes(revalidated.status)
    ) {
      throw conflict("session authorization changed; retry");
    }
    return grant;
  }
}
