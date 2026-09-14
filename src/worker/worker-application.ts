import { buildFleetState } from "../fleet-state.ts";
import { DesktopHostRepository } from "./desktop-host-repository.ts";
import { DesktopHostService } from "./desktop-host-service.ts";
import { publicDeploymentConfig } from "./deployment.ts";
import type { RuntimeEnv } from "./env.ts";
import type { User } from "./models.ts";
import { createNativeAuthService, type NativeAuthService } from "./native-auth.ts";
import type { NativeRouteDependencies } from "./routes/native.ts";

export class WorkerApplication {
  readonly hosts: DesktopHostService;
  readonly nativeAuth: NativeAuthService;
  private readonly env: RuntimeEnv;

  constructor(env: RuntimeEnv) {
    this.env = env;
    this.hosts = new DesktopHostService(new DesktopHostRepository(env));
    this.nativeAuth = createNativeAuthService(env);
  }

  async readFleet(user: User) {
    const { canonicalUrl, productUrl } = publicDeploymentConfig(this.env);
    return buildFleetState(await this.hosts.list(user), {
      canonicalUrl,
      productUrl,
      generatedAt: Date.now(),
    });
  }

  nativeRoutes(): NativeRouteDependencies {
    return {
      startDevice: (name, remoteIp, scope) => this.nativeAuth.start(name, remoteIp, scope),
      pollToken: (code) => this.nativeAuth.poll(code),
      requireUser: (request) => this.nativeAuth.authenticate(request),
      revokeToken: (request) => this.nativeAuth.revoke(request),
      readFleet: (user) => this.readFleet(user),
      deployment: publicDeploymentConfig(this.env),
    };
  }
}
