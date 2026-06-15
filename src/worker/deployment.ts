import { appCanonicalOrigin } from "../canonical-host.ts";
import {
  defaultInteractiveRuntime,
  parseInteractiveRuntimes,
  type ConfigurableInteractiveRuntime,
} from "../interactive-runtimes.ts";
import {
  parseRuntimeProfiles,
  runtimeProfileByID,
  type RuntimeProfileDescriptor,
} from "../runtime-profiles.ts";
import { trustedProxyPublicOrigin, type TrustedProxyEnv } from "../trusted-proxy-auth.ts";
import { configuredHttpOrigin } from "../url-security.ts";
import { badRequest } from "./http.ts";
import { normalizeRepo } from "./repositories.ts";

export const defaultPreferredRepo = "openclaw/crabfleet";

export type DeploymentConfig = {
  label: string;
  canonicalUrl: string;
  productUrl: string;
  sshHost: string;
  preferredRepo: string;
  defaultRuntime: ConfigurableInteractiveRuntime;
  interactiveRuntimes: ConfigurableInteractiveRuntime[];
  defaultProfile: string;
  runtimeProfiles: RuntimeProfileDescriptor[];
};

export type PublicDeploymentConfig = Pick<
  DeploymentConfig,
  "label" | "canonicalUrl" | "productUrl" | "sshHost"
>;

export type DeploymentEnv = TrustedProxyEnv & {
  CRABFLEET_LABEL?: string;
  CRABFLEET_CANONICAL_URL?: string;
  CRABFLEET_PRODUCT_URL?: string;
  CRABFLEET_SSH_HOST?: string;
  CRABFLEET_PREFERRED_REPO?: string;
  CRABFLEET_DEFAULT_RUNTIME?: string;
  CRABFLEET_INTERACTIVE_RUNTIMES?: string;
  CRABFLEET_DEFAULT_PROFILE?: string;
  CRABFLEET_RUNTIME_PROFILES_JSON?: string;
};

export function deploymentConfig(env: DeploymentEnv): DeploymentConfig {
  const defaultProfile = clean(env.CRABFLEET_DEFAULT_PROFILE, 120) || "default";
  const runtimeProfiles = parseRuntimeProfiles(env.CRABFLEET_RUNTIME_PROFILES_JSON);
  const interactiveRuntimes = parseInteractiveRuntimes(env.CRABFLEET_INTERACTIVE_RUNTIMES);
  if (runtimeProfiles.length > 0 && !runtimeProfileByID(runtimeProfiles, defaultProfile)) {
    throw new TypeError("CRABFLEET_DEFAULT_PROFILE must name a configured runtime profile");
  }
  return {
    label: clean(env.CRABFLEET_LABEL, 80) || "Crabfleet",
    canonicalUrl: configuredHttpOrigin(env.CRABFLEET_CANONICAL_URL, appCanonicalOrigin),
    productUrl: configuredHttpOrigin(env.CRABFLEET_PRODUCT_URL, "https://crabfleet.ai"),
    sshHost: clean(env.CRABFLEET_SSH_HOST, 240) || "crabd.sh",
    preferredRepo: normalizeRepo(env.CRABFLEET_PREFERRED_REPO) || defaultPreferredRepo,
    defaultRuntime: defaultInteractiveRuntime(env.CRABFLEET_DEFAULT_RUNTIME, interactiveRuntimes),
    interactiveRuntimes,
    defaultProfile,
    runtimeProfiles,
  };
}

export function selectedRuntimeProfile(
  deployment: DeploymentConfig,
  value: unknown,
): { profile: string; descriptor: RuntimeProfileDescriptor | undefined } {
  const profile = clean(value, 120) || deployment.defaultProfile;
  const descriptor = runtimeProfileByID(deployment.runtimeProfiles, profile);
  if (deployment.runtimeProfiles.length > 0 && !descriptor) {
    throw badRequest("profile is not configured");
  }
  return { profile, descriptor };
}

export function publicDeploymentConfig(env: DeploymentEnv): PublicDeploymentConfig {
  const { label, canonicalUrl, productUrl, sshHost } = deploymentConfig(env);
  return {
    label,
    canonicalUrl: trustedProxyPublicOrigin(env) ?? canonicalUrl,
    productUrl,
    sshHost,
  };
}

export function clientDeploymentConfig(env: DeploymentEnv): DeploymentConfig {
  const config = deploymentConfig(env);
  return {
    ...config,
    runtimeProfiles: config.runtimeProfiles.map(({ codexSsh: _serverOnly, ...profile }) => profile),
  };
}

export function browserAppOrigin(env: DeploymentEnv): string {
  return trustedProxyPublicOrigin(env) ?? deploymentConfig(env).canonicalUrl;
}

export function browserRequestOrigin(request: Request, env: DeploymentEnv): string {
  return trustedProxyPublicOrigin(env) ?? new URL(request.url).origin;
}

export function browserSessionUrl(env: DeploymentEnv, sessionId: string): string {
  return `${browserAppOrigin(env)}/app/sessions/${encodeURIComponent(sessionId)}`;
}

export function browserSessionEmbedUrl(
  env: DeploymentEnv,
  sessionId: string,
  token: string,
): string {
  return `${browserSessionUrl(env, sessionId)}?token=${encodeURIComponent(token)}`;
}

export function browserSessionShareUrl(
  request: Request,
  env: DeploymentEnv,
  sessionId: string,
  token: string,
): string {
  return `${browserRequestOrigin(request, env)}/sessions/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(token)}`;
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
