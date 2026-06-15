export type ConfigurableInteractiveRuntime = "container" | "crabbox";

export const defaultInteractiveRuntimes: ConfigurableInteractiveRuntime[] = [
  "container",
  "crabbox",
];

const configurableRuntimeSet = new Set<string>(defaultInteractiveRuntimes);

export function parseInteractiveRuntimes(
  value: string | undefined,
): ConfigurableInteractiveRuntime[] {
  if (value === undefined || value === "") return [...defaultInteractiveRuntimes];
  if (value !== value.trim() || value.length > 64) {
    throw new TypeError("CRABFLEET_INTERACTIVE_RUNTIMES must be a bounded comma-separated list");
  }

  const runtimes = value.split(",");
  if (
    runtimes.length === 0 ||
    runtimes.some((runtime) => !configurableRuntimeSet.has(runtime)) ||
    new Set(runtimes).size !== runtimes.length
  ) {
    throw new TypeError(
      "CRABFLEET_INTERACTIVE_RUNTIMES must contain unique container or crabbox values",
    );
  }
  return runtimes as ConfigurableInteractiveRuntime[];
}

export function defaultInteractiveRuntime(
  value: string | undefined,
  runtimes: ConfigurableInteractiveRuntime[],
): ConfigurableInteractiveRuntime {
  if (runtimes.length === 0) {
    throw new TypeError("at least one interactive runtime must be enabled");
  }
  if (value === undefined || value === "") {
    return runtimes.includes("container") ? "container" : runtimes[0]!;
  }
  if (
    !configurableRuntimeSet.has(value) ||
    !runtimes.includes(value as ConfigurableInteractiveRuntime)
  ) {
    throw new TypeError("CRABFLEET_DEFAULT_RUNTIME must name an enabled interactive runtime");
  }
  return value as ConfigurableInteractiveRuntime;
}
