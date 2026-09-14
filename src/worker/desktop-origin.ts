import { browserRequestOrigin } from "./deployment.ts";
import type { RuntimeEnv } from "./env.ts";
import { forbidden } from "./http.ts";

export function validateDesktopWebSocketOrigin(request: Request, env: RuntimeEnv): void {
  const origin = request.headers.get("origin");
  // Native transports omit Origin; browser handshakes must come from this deployment.
  if (origin && origin !== browserRequestOrigin(request, env)) {
    throw forbidden("desktop websocket origin is invalid");
  }
}
