export type TerminalRouteKind = "sandbox" | "bridge" | "attach" | "cloudflare";

export function sizedTerminalTargetUrl(
  rawUrl: string,
  routeKind: TerminalRouteKind | null,
  cols: number,
  rows: number,
): string {
  if (routeKind !== "bridge" && routeKind !== "cloudflare") return rawUrl;
  try {
    const url = new URL(rawUrl);
    url.searchParams.set("cols", String(cols));
    url.searchParams.set("rows", String(rows));
    return url.toString();
  } catch {
    return "";
  }
}
