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
  #latest: {
    frame: FrameDrawable;
    resolve: () => void;
    reject: (error: unknown) => void;
  } | null = null;
  #scheduled = false;

  constructor(canvas: CanvasElement) {
    this.canvas = canvas;
  }

  present(frame: FrameDrawable): Promise<void> {
    this.#discardLatest();
    const presentation = new Promise<void>((resolve, reject) => {
      this.#latest = { frame, resolve, reject };
    });
    if (!this.#scheduled) {
      this.#scheduled = true;
      requestAnimationFrame(() => this.#drawLatest());
    }
    return presentation;
  }

  clear(): void {
    this.#discardLatest();
    const context = this.canvas.getContext("2d");
    context?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  #discardLatest(): void {
    const latest = this.#latest;
    this.#latest = null;
    latest?.frame.close();
    latest?.resolve();
  }

  #drawLatest(): void {
    this.#scheduled = false;
    const latest = this.#latest;
    this.#latest = null;
    if (!latest) return;
    try {
      this.#draw(latest.frame);
      latest.resolve();
    } catch (error) {
      latest.reject(error);
    } finally {
      latest.frame.close();
    }
  }

  #draw(frame: FrameDrawable): void {
    const bounds = this.canvas.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(bounds.width * scale));
    const pixelHeight = Math.max(1, Math.round(bounds.height * scale));
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("2D canvas rendering is unavailable");
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
  }
}
