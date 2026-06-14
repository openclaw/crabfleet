export type RuntimeProfileCapabilities = {
  terminal: boolean;
  takeover: boolean;
  vnc: boolean;
  desktop: boolean;
  logs: boolean;
  artifacts: boolean;
};

export type RuntimeProfileDescriptor = {
  id: string;
  label: string;
  target?: string;
  capabilities: Partial<RuntimeProfileCapabilities>;
};

const profileIDPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,118}[A-Za-z0-9])?$/;
const targetPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38}[A-Za-z0-9])?$/;
const capabilityNames = ["terminal", "takeover", "vnc", "desktop", "logs", "artifacts"] as const;
const capabilityNameSet = new Set<string>(capabilityNames);
const descriptorKeys = new Set(["id", "label", "target", "capabilities"]);

export function parseRuntimeProfiles(value: string | undefined): RuntimeProfileDescriptor[] {
  if (value === undefined || value === "") return [];
  if (value !== value.trim() || value.length > 32_768) {
    throw new TypeError("CRABFLEET_RUNTIME_PROFILES_JSON must be bounded JSON without padding");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("CRABFLEET_RUNTIME_PROFILES_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32) {
    throw new TypeError("CRABFLEET_RUNTIME_PROFILES_JSON must contain 1 to 32 profiles");
  }

  const seen = new Set<string>();
  const seenLabels = new Set<string>();
  return parsed.map((entry, index) => {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !descriptorKeys.has(key))) {
      throw new TypeError(`runtime profile ${index + 1} has unsupported fields`);
    }
    const id = exactString(entry.id, 120);
    const label = exactString(entry.label, 80);
    const target = entry.target === undefined ? undefined : exactString(entry.target, 40);
    if (!profileIDPattern.test(id)) {
      throw new TypeError(`runtime profile ${index + 1} has an invalid id`);
    }
    if (!label) throw new TypeError(`runtime profile ${index + 1} needs a label`);
    if (target !== undefined && !targetPattern.test(target)) {
      throw new TypeError(`runtime profile ${index + 1} has an invalid target`);
    }
    if (seen.has(id)) throw new TypeError(`runtime profile ${index + 1} repeats an id`);
    const normalizedLabel = label.toLowerCase();
    if (seenLabels.has(normalizedLabel)) {
      throw new TypeError(`runtime profile ${index + 1} repeats a label`);
    }
    seen.add(id);
    seenLabels.add(normalizedLabel);

    const rawCapabilities = entry.capabilities ?? {};
    if (
      !isRecord(rawCapabilities) ||
      Object.keys(rawCapabilities).some((key) => !capabilityNameSet.has(key))
    ) {
      throw new TypeError(`runtime profile ${index + 1} has invalid capabilities`);
    }
    const capabilities: Partial<RuntimeProfileCapabilities> = {};
    for (const name of capabilityNames) {
      const configured = rawCapabilities[name];
      if (configured === undefined) continue;
      if (typeof configured !== "boolean") {
        throw new TypeError(`runtime profile ${index + 1} has a non-boolean capability`);
      }
      capabilities[name] = configured;
    }
    return { id, label, ...(target ? { target } : {}), capabilities };
  });
}

export function runtimeProfileByID(
  profiles: RuntimeProfileDescriptor[],
  id: string,
): RuntimeProfileDescriptor | undefined {
  return profiles.find((profile) => profile.id === id);
}

export function runtimeProfileCapabilities(
  profile: RuntimeProfileDescriptor | undefined,
  fallback: RuntimeProfileCapabilities,
): RuntimeProfileCapabilities {
  return { ...fallback, ...profile?.capabilities };
}

function exactString(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length > maximum ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 || codePoint === 0x7f;
    })
  ) {
    return "";
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
