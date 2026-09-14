export interface BrowserVideoFrame {
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  close(): void;
}

export interface BrowserVideoDecoder {
  readonly state: "unconfigured" | "configured" | "closed";
  readonly decodeQueueSize: number;
  configure(config: Record<string, unknown>): void;
  decode(chunk: unknown): void;
  close(): void;
}

interface VideoDecoderAPI {
  new (callbacks: {
    output(frame: BrowserVideoFrame): void;
    error(error: Error): void;
  }): BrowserVideoDecoder;
  isConfigSupported(config: Record<string, unknown>): Promise<{ supported?: boolean }>;
}

interface EncodedVideoChunkAPI {
  new (init: {
    type: "key" | "delta";
    timestamp: number;
    duration: number;
    data: Uint8Array;
  }): unknown;
}

export function videoDecoderAPI(): VideoDecoderAPI | undefined {
  return (globalThis as unknown as { VideoDecoder?: VideoDecoderAPI }).VideoDecoder;
}

export function encodedVideoChunkAPI(): EncodedVideoChunkAPI {
  const api = (globalThis as unknown as { EncodedVideoChunk?: EncodedVideoChunkAPI })
    .EncodedVideoChunk;
  if (!api) throw new Error("WebCodecs EncodedVideoChunk is unavailable");
  return api;
}

export async function supportsVideoCodec(codec: string): Promise<boolean> {
  const api = videoDecoderAPI();
  if (!api) return false;
  try {
    const result = await api.isConfigSupported({ codec, optimizeForLatency: true });
    return result.supported === true;
  } catch {
    return false;
  }
}
