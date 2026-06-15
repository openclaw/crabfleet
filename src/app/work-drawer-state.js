import { configurableInteractiveRuntimeOptions } from "../interactive-runtimes.ts";
import { runCapabilities } from "./utils.js";

export function interactiveCreationDefaults(deployment) {
  const configured = Array.isArray(deployment?.interactiveRuntimes)
    ? deployment.interactiveRuntimes
    : configurableInteractiveRuntimeOptions.map(({ id }) => id);
  const runtimes = configurableInteractiveRuntimeOptions.filter(({ id }) =>
    configured.includes(id),
  );
  const runtime = runtimes.some(({ id }) => id === deployment?.defaultRuntime)
    ? deployment.defaultRuntime
    : runtimes[0]?.id || "container";
  return {
    runtime,
    runtimes,
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
