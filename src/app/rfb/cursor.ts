export interface CursorPoint {
  x: number;
  y: number;
}

export interface BrowserCursorImage {
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  rgba: Uint8Array;
}

export function cursorCSS(
  dataURL: string,
  hotspotX: number,
  hotspotY: number,
  width: number,
  height: number,
): string {
  if (
    !dataURL.startsWith("data:image/") ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 128 ||
    height > 128 ||
    !Number.isInteger(hotspotX) ||
    !Number.isInteger(hotspotY) ||
    hotspotX < 0 ||
    hotspotY < 0 ||
    hotspotX >= width ||
    hotspotY >= height
  ) {
    throw new Error("invalid browser cursor");
  }
  return `url("${dataURL}") ${hotspotX} ${hotspotY}, default`;
}

export function shouldShowCursorOverlay(
  remote: CursorPoint | null,
  local: CursorPoint | null,
  hasPointerFocus: boolean,
): boolean {
  if (!remote) return false;
  if (!hasPointerFocus || !local) return true;
  return remote.x !== local.x || remote.y !== local.y;
}

export function remotePointerAfterCursorShape(
  current: CursorPoint | null,
  hasCursorImage: boolean,
): CursorPoint | null {
  return hasCursorImage ? current : null;
}
