import {
  GHOSTTY_BROWSER_EXTERNAL_JS,
  GHOSTTY_BROWSER_EXTERNAL_PATH,
  GHOSTTY_VT_WASM_BASE64,
  GHOSTTY_VT_WASM_PATH,
  GHOSTTY_WEB_JS,
  GHOSTTY_WEB_PATH,
} from "../generated.ts";
import { securityHeaders, text } from "./http.ts";

export function terminalAssetResponse(pathname: string): Response | null {
  if (pathname === GHOSTTY_WEB_PATH) {
    return text(GHOSTTY_WEB_JS, "text/javascript; charset=utf-8", {
      "cache-control": "no-store",
    });
  }
  if (pathname === GHOSTTY_VT_WASM_PATH) {
    return new Response(base64Bytes(GHOSTTY_VT_WASM_BASE64), {
      headers: {
        ...securityHeaders("application/wasm"),
        "cache-control": "no-store",
      },
    });
  }
  if (pathname === GHOSTTY_BROWSER_EXTERNAL_PATH) {
    return text(GHOSTTY_BROWSER_EXTERNAL_JS, "text/javascript; charset=utf-8", {
      "cache-control": "no-store",
    });
  }
  return null;
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
