import { runCapabilities } from "./utils.js";

export function interactiveCreationDefaults(deployment) {
  return {
    runtime: deployment?.defaultRuntime || "container",
    profile: deployment?.defaultProfile || "default",
    profiles: deployment?.runtimeProfiles || [],
  };
}

export function runCapabilitySummary(card) {
  const capabilities = runCapabilities(card);
  const label = Object.entries(capabilities)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(", ");
  return { capabilities, label: label || "none" };
}
