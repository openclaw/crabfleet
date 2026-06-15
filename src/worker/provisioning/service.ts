import type {
  InteractiveProvisionRequest,
  InteractiveProvisionResult,
  InteractiveProvisionRuntime,
  SandboxProvisionOwnership,
} from "./types.ts";

export type ManagedInteractiveProvisionBackend = "sandbox" | "runtime-adapter";

export type InteractiveProvisioningDependencies = {
  sandboxAvailable: boolean;
  runtimeAdapterAvailable: boolean;
  provisionSandbox(
    session: InteractiveProvisionRequest,
    agentToken: string | undefined,
    sandbox: SandboxProvisionOwnership,
  ): Promise<InteractiveProvisionResult>;
  provisionRuntimeAdapter(
    session: InteractiveProvisionRequest,
    agentToken: string | undefined,
  ): Promise<InteractiveProvisionResult>;
};

export class InteractiveProvisioningService {
  private readonly dependencies: InteractiveProvisioningDependencies;

  constructor(dependencies: InteractiveProvisioningDependencies) {
    this.dependencies = dependencies;
  }

  async provisionManaged(
    session: InteractiveProvisionRequest,
    agentToken?: string,
    sandbox?: SandboxProvisionOwnership,
  ): Promise<InteractiveProvisionResult | null> {
    const backend = this.managedBackend(session.runtime);
    if (backend === "sandbox") {
      if (!sandbox) {
        return failedProvision("Cloudflare Sandbox durable ownership is missing");
      }
      return this.dependencies.provisionSandbox(session, agentToken, sandbox);
    }
    if (backend === "runtime-adapter") {
      return this.dependencies.provisionRuntimeAdapter(session, agentToken);
    }
    return null;
  }

  supportsStandalone(runtime: InteractiveProvisionRuntime): boolean {
    return runtime === "container" && this.dependencies.sandboxAvailable;
  }

  private managedBackend(
    runtime: InteractiveProvisionRuntime,
  ): ManagedInteractiveProvisionBackend | null {
    if (runtime === "container" && this.dependencies.sandboxAvailable) return "sandbox";
    if (this.dependencies.runtimeAdapterAvailable) return "runtime-adapter";
    return null;
  }
}

function failedProvision(message: string): InteractiveProvisionResult {
  return {
    status: "failed",
    leaseId: null,
    attachUrl: null,
    vncUrl: null,
    message,
  };
}
