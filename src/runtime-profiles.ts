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
  codexSsh?: RuntimeProfileCodexSsh;
};

export type RuntimeProfileCodexSsh = {
  aliasTemplate: string;
  setupCommand?: string[];
};

export type ResolvedRuntimeProfileCodexSsh = {
  alias: string;
  setupCommand: string | null;
};

export type RuntimeProfileCodexSshValues = {
  providerResourceId: string | null;
  workspaceId: string | null;
  sessionId: string;
  profile: string;
};

const profileIDPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const targetPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38}[A-Za-z0-9])?$/;
const capabilityNames = ["terminal", "takeover", "vnc", "desktop", "logs", "artifacts"] as const;
const capabilityNameSet = new Set<string>(capabilityNames);
const descriptorKeys = new Set(["id", "label", "target", "capabilities", "codexSsh"]);
const codexSshKeys = new Set(["aliasTemplate", "setupCommand"]);
const codexSshPlaceholders = ["providerResourceId", "workspaceId", "sessionId", "profile"] as const;
const codexSshPlaceholderSet = new Set<string>(codexSshPlaceholders);
const codexSshAliasPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,238}[A-Za-z0-9])?$/;
const codexSshSetupStaticTokenPattern = /^[A-Za-z0-9_./:@%+=,-]+$/;

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

    const rawCapabilities = entry.capabilities === undefined ? {} : entry.capabilities;
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
    const codexSsh = parseRuntimeProfileCodexSsh(entry.codexSsh, index);
    return {
      id,
      label,
      ...(target ? { target } : {}),
      capabilities,
      ...(codexSsh ? { codexSsh } : {}),
    };
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

export function resolveRuntimeProfileCodexSsh(
  profile: RuntimeProfileDescriptor | undefined,
  values: RuntimeProfileCodexSshValues,
): ResolvedRuntimeProfileCodexSsh | null {
  const configured = profile?.codexSsh;
  if (!configured) return null;

  const aliasReplacements: Record<string, string | null> = {
    providerResourceId: safeCodexSshAliasValue(values.providerResourceId),
    workspaceId: safeCodexSshAliasValue(values.workspaceId),
    sessionId: safeCodexSshAliasValue(values.sessionId),
    profile: safeCodexSshAliasValue(values.profile),
  };
  const alias = resolveCodexSshTemplate(configured.aliasTemplate, aliasReplacements);
  if (!alias || !codexSshAliasPattern.test(alias)) return null;
  const setupCommand = configured.setupCommand
    ? resolveCodexSshSetupCommand(configured.setupCommand, values)
    : null;
  if (configured.setupCommand && !setupCommand) return null;
  return { alias, setupCommand };
}

function parseRuntimeProfileCodexSsh(
  value: unknown,
  profileIndex: number,
): RuntimeProfileCodexSsh | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).some((key) => !codexSshKeys.has(key))) {
    throw new TypeError(`runtime profile ${profileIndex + 1} has invalid codexSsh settings`);
  }
  const aliasTemplate = exactString(value.aliasTemplate, 240);
  if (!aliasTemplate || !validCodexSshAliasTemplate(aliasTemplate)) {
    throw new TypeError(`runtime profile ${profileIndex + 1} has an invalid SSH alias template`);
  }
  const sampleAlias = resolveCodexSshTemplate(aliasTemplate, {
    providerResourceId: "resource",
    workspaceId: "workspace",
    sessionId: "session",
    profile: "profile",
  });
  if (!sampleAlias || !codexSshAliasPattern.test(sampleAlias)) {
    throw new TypeError(`runtime profile ${profileIndex + 1} has an invalid SSH alias template`);
  }

  const setupCommand = parseCodexSshSetupCommand(value.setupCommand, profileIndex);
  return {
    aliasTemplate,
    ...(setupCommand ? { setupCommand } : {}),
  };
}

function validCodexSshAliasTemplate(value: string): boolean {
  if (/\s/u.test(value)) return false;
  const withoutPlaceholders = value.replace(/\{([^{}]+)\}/gu, (_match, name: string) =>
    codexSshPlaceholderSet.has(name) ? "value" : "{invalid}",
  );
  return !/[{}]/u.test(withoutPlaceholders);
}

function parseCodexSshSetupCommand(value: unknown, profileIndex: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new TypeError(`runtime profile ${profileIndex + 1} has an invalid SSH setup command`);
  }
  const tokens = value.map((token) => exactString(token, 120));
  if (
    tokens.some((token, index) => {
      if (!token) return true;
      const placeholder = /^\{([^{}]+)\}$/u.exec(token);
      if (placeholder) return index === 0 || !codexSshPlaceholderSet.has(placeholder[1] ?? "");
      return !codexSshSetupStaticTokenPattern.test(token);
    }) ||
    tokens.join(" ").length > 500
  ) {
    throw new TypeError(`runtime profile ${profileIndex + 1} has an invalid SSH setup command`);
  }
  return tokens;
}

function resolveCodexSshTemplate(
  template: string,
  values: Record<string, string | null>,
): string | null {
  const unresolved = template.replace(/\{([^{}]+)\}/gu, (_match, name: string) =>
    codexSshPlaceholderSet.has(name) ? "" : "{invalid}",
  );
  if (/[{}]/u.test(unresolved)) return null;
  let missing = false;
  const result = template.replace(/\{([^{}]+)\}/gu, (_match, name: string) => {
    const value = values[name];
    if (!codexSshPlaceholderSet.has(name) || !value) {
      missing = true;
      return "";
    }
    return value;
  });
  return missing ? null : result;
}

function safeCodexSshAliasValue(value: string | null): string | null {
  const exact = exactString(value, 240);
  return exact && codexSshAliasPattern.test(exact) ? exact : null;
}

function resolveCodexSshSetupCommand(
  command: string[],
  values: RuntimeProfileCodexSshValues,
): string | null {
  const replacements: Record<string, string | null> = {
    providerResourceId: shellQuoteCodexSshValue(values.providerResourceId),
    workspaceId: shellQuoteCodexSshValue(values.workspaceId),
    sessionId: shellQuoteCodexSshValue(values.sessionId),
    profile: shellQuoteCodexSshValue(values.profile),
  };
  const tokens = command.map((token) => {
    const placeholder = /^\{([^{}]+)\}$/u.exec(token);
    return placeholder ? (replacements[placeholder[1] ?? ""] ?? null) : token;
  });
  if (tokens.some((token) => token === null)) return null;
  const result = tokens.join(" ");
  return result.length <= 2_048 ? result : null;
}

function shellQuoteCodexSshValue(value: string | null): string | null {
  const exact = exactString(value, 240);
  return exact ? `'${exact.replaceAll("'", `'"'"'`)}'` : null;
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
