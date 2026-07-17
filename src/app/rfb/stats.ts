export interface ViewerStatsSnapshot {
  fps: number;
  mbitPerSecond: number;
}

interface Sample {
  at: number;
  value: number;
}

export class ViewerStatsWindow {
  readonly windowMs: number;
  #startedAt: number;
  #frames: number[] = [];
  #traffic: Sample[] = [];

  constructor(startedAt: number, windowMs = 1_000) {
    if (!Number.isFinite(startedAt) || !Number.isFinite(windowMs) || windowMs <= 0)
      throw new Error("invalid stats window");
    this.#startedAt = startedAt;
    this.windowMs = windowMs;
  }

  recordDecodedFrame(at: number): void {
    this.#frames.push(at);
    this.#prune(at);
  }

  recordTraffic(bytes: number, at: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error("invalid traffic sample");
    this.#traffic.push({ at, value: bytes });
    this.#prune(at);
  }

  snapshot(at: number): ViewerStatsSnapshot {
    this.#prune(at);
    const elapsed = Math.max(1, Math.min(this.windowMs, at - this.#startedAt));
    const bytes = this.#traffic.reduce((total, sample) => total + sample.value, 0);
    return {
      fps: (this.#frames.length * 1_000) / elapsed,
      mbitPerSecond: (bytes * 8) / (elapsed * 1_000),
    };
  }

  #prune(at: number): void {
    const cutoff = at - this.windowMs;
    while (this.#frames.length && this.#frames[0]! <= cutoff) this.#frames.shift();
    while (this.#traffic.length && this.#traffic[0]!.at <= cutoff) this.#traffic.shift();
    if (at - this.#startedAt > this.windowMs) this.#startedAt = at - this.windowMs;
  }
}
