import type { DesktopHost } from "./worker/desktop-host-service.ts";

export function buildFleetState(
  desktopHosts: DesktopHost[],
  options: { canonicalUrl: string; productUrl: string; generatedAt: number },
) {
  return {
    ...options,
    desktopHosts: [...desktopHosts].sort(
      (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
    ),
    registryAvailable: true,
    // Released native clients require this envelope when decoding desktop discovery.
    sessions: [],
    totals: { active: 0, sessions: 0, vnc: 0 },
  };
}
