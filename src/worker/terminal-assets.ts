import { readGhosttyWorkerAsset } from "@openclaw/libterminal/worker-assets";

import { securityHeaders } from "./http.ts";

export function terminalAssetResponse(pathname: string): Response | null {
  const asset = readGhosttyWorkerAsset(pathname);
  if (!asset) {
    return null;
  }
  const body = new Uint8Array(asset.body.byteLength);
  body.set(asset.body);
  return new Response(body.buffer, {
    headers: {
      ...securityHeaders(asset.contentType),
      "cache-control": "no-store",
    },
  });
}
