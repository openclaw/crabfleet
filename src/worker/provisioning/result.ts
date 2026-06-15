import { redactedAdapterMessage } from "../../runtime-adapter.ts";
import type { InteractiveProvisionResult } from "./types.ts";

export function failedProvision(message: string): InteractiveProvisionResult {
  return {
    status: "failed",
    leaseId: null,
    attachUrl: null,
    vncUrl: null,
    message,
  };
}

export function safeProviderError(
  error: unknown,
  identifiers: Array<string | null> = [],
  connectionValues: Array<string | null> = [],
): string {
  return redactedAdapterMessage(
    String(error instanceof Error ? error.message : error)
      .trim()
      .slice(0, 2000),
    "failed",
    identifiers,
    connectionValues,
  );
}
