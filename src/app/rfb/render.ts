export interface FrameDrawable {
  width: number;
  height: number;
  displayWidth?: number;
  displayHeight?: number;
  close(): void;
}

interface CanvasContext {
  fillStyle: string;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  drawImage(image: unknown, x: number, y: number, width: number, height: number): void;
}

interface CanvasElement {
  width: number;
  height: number;
  getBoundingClientRect(): { width: number; height: number };
  getContext(kind: "2d", options?: { alpha: boolean }): CanvasContext | null;
}

declare const requestAnimationFrame: (callback: () => void) => number;
declare const window: { devicePixelRatio?: number };

export class CanvasRenderer {
  readonly canvas: CanvasElement;
  #latest: FrameDrawable | null = null;
  #scheduled = false;
  #resolveLatest: (() => void) | null = null;
  #rejectLatest: ((error: Error) => void) | null = null;

  constructor(canvas: CanvasElement) {
    this.canvas = canvas;
  }

  present(frame: FrameDrawable): Promise<void> {
    this.#latest?.close();
    this.#resolveLatest?.();
    this.#rejectLatest = null;
    this.#latest = frame;
    if (!this.#scheduled) {
      this.#scheduled = true;
      requestAnimationFrame(() => this.#drawLatest());
    }
    return new Promise((resolve, reject) => {
      this.#resolveLatest = resolve;
      this.#rejectLatest = reject;
    });
  }

  clear(): void {
    this.#latest?.close();
    this.#latest = null;
    this.#resolveLatest?.();
    this.#resolveLatest = null;
    this.#rejectLatest = null;
    const context = this.canvas.getContext("2d");
    context?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  #drawLatest(): void {
    this.#scheduled = false;
    const frame = this.#latest;
    this.#latest = null;
    if (!frame) return;
    const bounds = this.canvas.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(bounds.width * scale));
    const pixelHeight = Math.max(1, Math.round(bounds.height * scale));
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) {
      frame.close();
      this.#rejectLatest?.(new Error("2D canvas rendering is unavailable"));
      this.#resolveLatest = null;
      this.#rejectLatest = null;
      return;
    }
    const sourceWidth = frame.displayWidth ?? frame.width;
    const sourceHeight = frame.displayHeight ?? frame.height;
    const fit = Math.min(pixelWidth / sourceWidth, pixelHeight / sourceHeight);
    const width = Math.round(sourceWidth * fit);
    const height = Math.round(sourceHeight * fit);
    const x = Math.floor((pixelWidth - width) / 2);
    const y = Math.floor((pixelHeight - height) / 2);
    context.fillStyle = "#020307";
    context.fillRect(0, 0, pixelWidth, pixelHeight);
    context.drawImage(frame, x, y, width, height);
    frame.close();
    this.#resolveLatest?.();
    this.#resolveLatest = null;
    this.#rejectLatest = null;
  }
}
