import type { SessionTerminatedError as CloudflareSandboxSessionError } from "@cloudflare/sandbox";

type SandboxErrorDetails = {
  code?: CloudflareSandboxSessionError["code"];
  context?: unknown;
};

export function isSandboxSessionAlreadyExists(error: unknown, sessionId: string): boolean {
  return hasSandboxSessionErrorCode(error, "SESSION_ALREADY_EXISTS", sessionId);
}

export function isSandboxSessionAlreadyGone(error: unknown, sessionId: string): boolean {
  return (
    hasSandboxSessionErrorCode(error, "SESSION_DESTROYED", sessionId) ||
    hasSandboxSessionErrorCode(error, "SESSION_TERMINATED", sessionId) ||
    hasSandboxSessionErrorCode(error, "FILE_NOT_FOUND", sessionId) ||
    sandboxSessionNotFoundMessage(error, sessionId)
  );
}

function hasSandboxSessionErrorCode(
  error: unknown,
  code: CloudflareSandboxSessionError["code"],
  sessionId: string,
): boolean {
  const response = sandboxErrorResponse(error);
  if (response?.code !== code) return false;
  const responseSessionId = sandboxErrorSessionId(response);
  return responseSessionId === null || responseSessionId === sessionId;
}

function sandboxErrorResponse(error: unknown): SandboxErrorDetails | null {
  if (!error || typeof error !== "object") return null;
  const response = (error as { errorResponse?: unknown }).errorResponse;
  if (response && typeof response === "object") {
    return response as SandboxErrorDetails;
  }
  return error as SandboxErrorDetails;
}

function sandboxErrorSessionId(response: SandboxErrorDetails): string | null {
  const context = response.context;
  if (!context || typeof context !== "object") return null;
  const sessionId = (context as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" ? sessionId : null;
}

function sandboxSessionNotFoundMessage(error: unknown, sessionId: string): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message === `Session '${sessionId}' not found` || message === `Session "${sessionId}" not found`
  );
}
