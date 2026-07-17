const namedKeysyms: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Home: 0xff50,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  Insert: 0xff63,
  Delete: 0xffff,
  Shift: 0xffe1,
  Control: 0xffe3,
  CapsLock: 0xffe5,
  Meta: 0xffe7,
  Alt: 0xffe9,
};

for (let index = 1; index <= 24; index += 1) namedKeysyms[`F${index}`] = 0xffbd + index;

export function keysymForKey(key: string): number | null {
  const named = namedKeysyms[key];
  if (named !== undefined) return named;
  const points = [...key];
  if (points.length !== 1) return null;
  const codePoint = points[0]?.codePointAt(0);
  if (codePoint === undefined) return null;
  return codePoint <= 0xff ? codePoint : 0x01000000 | codePoint;
}

export function pointerCoordinates(
  event: { clientX: number; clientY: number },
  element: {
    getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  },
  width: number,
  height: number,
): { x: number; y: number } {
  const bounds = element.getBoundingClientRect();
  const fit = Math.min(bounds.width / width, bounds.height / height);
  const activeWidth = width * fit;
  const activeHeight = height * fit;
  const left = bounds.left + (bounds.width - activeWidth) / 2;
  const top = bounds.top + (bounds.height - activeHeight) / 2;
  const x = Math.round(((event.clientX - left) / Math.max(activeWidth, 1)) * width);
  const y = Math.round(((event.clientY - top) / Math.max(activeHeight, 1)) * height);
  return {
    x: Math.max(0, Math.min(width - 1, x)),
    y: Math.max(0, Math.min(height - 1, y)),
  };
}

export function pointerButtonMask(buttons: number): number {
  let mask = 0;
  if (buttons & 1) mask |= 1;
  if (buttons & 4) mask |= 2;
  if (buttons & 2) mask |= 4;
  return mask;
}

export function scrollButtonMask(deltaX: number, deltaY: number): number {
  if (deltaX === 0 && deltaY === 0) return 0;
  if (Math.abs(deltaY) >= Math.abs(deltaX)) return deltaY < 0 ? 0x08 : 0x10;
  return deltaX < 0 ? 0x20 : 0x40;
}
