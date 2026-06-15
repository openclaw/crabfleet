import { runtimeAdapterControlPlaneForProfile } from "../runtime-adapter.ts";
import type { RuntimeEnv } from "./env.ts";
import { serviceUnavailable } from "./http.ts";

export function requireRuntimeAdapterCreatePreflight(
  env: RuntimeEnv,
  runtime: "crabbox" | "container",
  profile: string,
): void {
  if (!runtimeAdapterConfigurationPresent(env) || (runtime === "container" && env.SANDBOX)) return;
  if (!configuredRuntimeAdapterControlPlane(env, profile)) {
    throw serviceUnavailable(
      "runtime adapter URL or profile route template must be valid and unambiguous",
    );
  }
  if (!runtimeAdapterToken(env)) {
    throw serviceUnavailable("runtime adapter token is not configured");
  }
}

export function runtimeAdapterConfigurationPresent(env: RuntimeEnv): boolean {
  return Boolean(env.CRABBOX_RUNTIME_ADAPTER_URL || env.CRABBOX_RUNTIME_ADAPTER_URL_TEMPLATE);
}

export function configuredRuntimeAdapterControlPlane(
  env: RuntimeEnv,
  profile: string,
): string | null {
  return runtimeAdapterControlPlaneForProfile(
    env.CRABBOX_RUNTIME_ADAPTER_URL,
    env.CRABBOX_RUNTIME_ADAPTER_URL_TEMPLATE,
    profile,
  );
}

export function runtimeAdapterToken(env: RuntimeEnv): string {
  return String(env.CRABBOX_RUNTIME_ADAPTER_TOKEN ?? "")
    .trim()
    .slice(0, 4000);
}

export function requireRegisteredRuntimeAdapterControlPlane(
  env: RuntimeEnv,
  profile: string,
  registeredControlPlane: string | null | undefined,
): string {
  if (!registeredControlPlane) {
    throw new Error("runtime adapter control-plane registration is missing");
  }
  const configuredControlPlane = configuredRuntimeAdapterControlPlane(env, profile);
  if (!configuredControlPlane) {
    throw new Error("runtime adapter control plane is unavailable");
  }
  if (configuredControlPlane !== registeredControlPlane) {
    throw new Error("runtime adapter control plane differs from workspace registration");
  }
  if (!runtimeAdapterToken(env)) throw new Error("runtime adapter token is not configured");
  return registeredControlPlane;
}
