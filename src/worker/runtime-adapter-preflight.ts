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
