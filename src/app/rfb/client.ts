import type { RFBAudioMessage } from "./audio.ts";

export const RFB_ENCODINGS = {
  hevc: 0x4845_5631,
  openH264: 50,
  tight: 7,
  audio: 0x4341_4631,
  chroma444: 0x4334_3434,
  extendedDesktopSize: -308,
  extendedClipboard: -1_063_131_698,
} as const;

const clipboardText = 1;
const clipboardCaps = 1 << 24;
const clipboardRequest = 1 << 25;
const clipboardPeek = 1 << 26;
const clipboardNotify = 1 << 27;
const clipboardProvide = 1 << 28;
const maximumClipboardBytes = 1 * 1_024 * 1_024;

export interface RFBTransport {
  readExactly(count: number): Promise<Uint8Array>;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface RFBServerInfo {
  width: number;
  height: number;
  name: string;
  codec: "HEVC" | "H.264" | "JPEG";
}

export interface RFBFrame {
  encoding: "hevc" | "h264" | "jpeg";
  width: number;
  height: number;
  payload: Uint8Array;
  flags: number;
}

export interface RFBClientOptions {
  hevc?: boolean;
  h264: boolean;
  chroma444?: boolean;
  audio?: boolean;
  onState?: (state: string) => void;
  onReady?: () => void;
  onServerInit?: (info: RFBServerInfo) => void;
  onFrame?: (frame: RFBFrame) => Promise<void> | void;
  onResize?: (width: number, height: number) => void;
  onClipboard?: (text: string) => void;
  onClipboardError?: (message: string) => void;
  onTraffic?: (bytes: number) => void;
  onAudio?: (message: RFBAudioMessage) => void;
}

interface RFBScreenLayout {
  id: number;
  flags: number;
}

export class RFBClient {
  readonly transport: RFBTransport;
  width = 0;
  height = 0;
  codec: "HEVC" | "H.264" | "JPEG";
  #options: RFBClientOptions;
  #running = false;
  #serverClipboardActions = 0;
  #serverClipboardMaximum = 0;
  #screenLayout: RFBScreenLayout | null = null;
  #pendingResize: { width: number; height: number } | null = null;
  #h264Enabled: boolean;
  #hevcEnabled: boolean;
  #chroma444Enabled: boolean;
  #audioEnabled: boolean;
  #approvedClipboardText: string | null = null;
  #forceFullRefresh = false;

  constructor(transport: RFBTransport, options: RFBClientOptions) {
    this.transport = transport;
    this.#options = options;
    this.#hevcEnabled = options.hevc === true;
    this.#h264Enabled = options.h264;
    this.#chroma444Enabled = options.chroma444 === true;
    this.#audioEnabled = options.audio === true;
    this.codec = this.#hevcEnabled ? "HEVC" : options.h264 ? "H.264" : "JPEG";
  }

  async start(): Promise<void> {
    this.#running = true;
    try {
      this.#options.onState?.("Negotiating RFB 3.8");
      await this.#handshake();
      this.#options.onState?.("Connected");
      this.#options.onReady?.();
      this.requestFramebuffer(false);
      while (this.#running) await this.#readServerMessage();
    } catch (error) {
      if (!this.#running) return;
      this.#running = false;
      this.transport.close(1002, "RFB protocol error");
      this.#options.onState?.(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.#running = false;
    }
  }

  disconnect(): void {
    this.#running = false;
    this.transport.close();
  }

  reportDecoderFailure(codec: "hevc" | "h264", _error: Error): void {
    if (!this.#running) return;
    const isHEVC = codec === "hevc";
    if (isHEVC ? !this.#hevcEnabled : !this.#h264Enabled) return;
    if (isHEVC) {
      this.#hevcEnabled = false;
      this.codec = this.#h264Enabled ? "H.264" : "JPEG";
    } else {
      this.#h264Enabled = false;
      this.codec = "JPEG";
    }
    this.#forceFullRefresh = true;
    this.transport.send(encodeSetEncodings(this.#enabledEncodings()));
    this.#options.onState?.(
      isHEVC
        ? this.#h264Enabled
          ? "HEVC unavailable; switching to H.264"
          : "HEVC unavailable; switching to JPEG / Tight"
        : "H.264 unavailable; switching to JPEG / Tight",
    );
  }

  requestCodecRefresh(): void {
    if (this.#running) this.#forceFullRefresh = true;
  }

  requestFramebuffer(incremental = true): void {
    this.transport.send(
      concat(
        new Uint8Array([3, incremental ? 1 : 0]),
        uint16(0),
        uint16(0),
        uint16(this.width),
        uint16(this.height),
      ),
    );
  }

  sendKey(down: boolean, keysym: number): void {
    this.transport.send(concat(new Uint8Array([4, down ? 1 : 0, 0, 0]), uint32(keysym)));
  }

  sendPointer(mask: number, x: number, y: number): void {
    this.transport.send(concat(new Uint8Array([5, mask & 0xff]), uint16(x), uint16(y)));
  }

  resize(width: number, height: number): void {
    const boundedWidth = Math.max(1, Math.min(0xffff, Math.round(width)));
    const boundedHeight = Math.max(1, Math.min(0xffff, Math.round(height)));
    if (!this.#screenLayout) {
      this.#pendingResize = { width: boundedWidth, height: boundedHeight };
      return;
    }
    this.transport.send(
      concat(
        new Uint8Array([251, 0]),
        uint16(boundedWidth),
        uint16(boundedHeight),
        new Uint8Array([1, 0]),
        uint32(this.#screenLayout.id),
        uint16(0),
        uint16(0),
        uint16(boundedWidth),
        uint16(boundedHeight),
        uint32(this.#screenLayout.flags),
      ),
    );
  }

  async sendClipboardText(text: string): Promise<void> {
    const utf8 = new TextEncoder().encode(normalizeClipboardText(text));
    // Extended Clipboard appends a NUL terminator; bound on the wire size so the
    // notify fallback cannot report success for text a later provide must reject.
    if (utf8.byteLength + 1 > maximumClipboardBytes)
      throw new Error("clipboard text exceeds 1 MiB");
    const canCompress = typeof CompressionStream !== "undefined";
    if (
      this.#serverClipboardActions & clipboardProvide &&
      utf8.byteLength + 1 <= this.#serverClipboardMaximum &&
      canCompress
    ) {
      await this.#sendClipboardProvide(text);
    } else {
      const latin1 = encodeLatin1(text);
      if (latin1) this.transport.send(cutTextFrame(6, latin1, false));
      else if (this.#serverClipboardActions & clipboardNotify && canCompress)
        this.transport.send(cutTextFrame(6, encodeClipboardNotify(true)));
      else throw new Error("this browser cannot encode the remote clipboard text");
    }
    this.#approvedClipboardText = text;
  }

  async #handshake(): Promise<void> {
    const serverBanner = new TextDecoder().decode(await this.transport.readExactly(12));
    if (serverBanner !== "RFB 003.008\n")
      throw new Error(`unsupported RFB banner ${JSON.stringify(serverBanner)}`);
    this.transport.send(new TextEncoder().encode("RFB 003.008\n"));

    const securityCount = (await this.transport.readExactly(1))[0]!;
    if (!securityCount) throw new Error("RFB server offered no security types");
    const securityTypes = await this.transport.readExactly(securityCount);
    if (!securityTypes.includes(1)) throw new Error("RFB relay requires security None");
    this.transport.send(new Uint8Array([1]));
    if (readUint32(await this.transport.readExactly(4)) !== 0)
      throw new Error("RFB security negotiation failed");
    this.transport.send(new Uint8Array([1]));

    const init = await this.transport.readExactly(24);
    this.width = readUint16(init, 0);
    this.height = readUint16(init, 2);
    const nameLength = readUint32(init, 20);
    if (nameLength > 4096) throw new Error("RFB desktop name is too long");
    const name = new TextDecoder().decode(await this.transport.readExactly(nameLength));
    this.#options.onServerInit?.({
      width: this.width,
      height: this.height,
      name,
      codec: this.codec,
    });

    this.transport.send(encodeSetEncodings(this.#enabledEncodings()));
    this.transport.send(
      cutTextFrame(
        6,
        encodeClipboardCaps(
          maximumClipboardBytes,
          typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined",
        ),
      ),
    );
  }

  async #readServerMessage(): Promise<void> {
    const type = (await this.transport.readExactly(1))[0]!;
    if (type === 0) {
      await this.#readFramebufferUpdate();
      return;
    }
    if (type === 3) {
      await this.#readServerCutText();
      return;
    }
    if (type === 2) return;
    if (type === 200) {
      const message = await readRFBAudioMessage(this.transport);
      this.#options.onAudio?.(message);
      if (message.kind === "packet") this.#options.onTraffic?.(message.payload.byteLength);
      return;
    }
    throw new Error(`unsupported RFB server message ${type}`);
  }

  async #readFramebufferUpdate(): Promise<void> {
    const header = await this.transport.readExactly(3);
    const rectangleCount = readUint16(header, 1);
    let forceFullRefresh = false;
    for (let index = 0; index < rectangleCount; index += 1) {
      const rectangle = await this.transport.readExactly(12);
      const x = readUint16(rectangle, 0);
      const y = readUint16(rectangle, 2);
      const width = readUint16(rectangle, 4);
      const height = readUint16(rectangle, 6);
      const encoding = readInt32(rectangle, 8);
      // Crabfleet hosts send one full-frame media rectangle per requested update.
      if (encoding === RFB_ENCODINGS.hevc || encoding === RFB_ENCODINGS.openH264) {
        const isHEVC = encoding === RFB_ENCODINGS.hevc;
        const label = isHEVC ? "HEVC" : "H.264";
        if (x !== 0 || y !== 0)
          throw new Error(`Crabfleet ${label} updates must cover the full framebuffer`);
        const frameHeader = await this.transport.readExactly(8);
        const length = readUint32(frameHeader, 0);
        if (!length || length >= 16 * 1_024 * 1_024)
          throw new Error(`${label} frame exceeds protocol bounds`);
        const payload = await this.transport.readExactly(length);
        this.#options.onTraffic?.(length);
        if (isHEVC ? !this.#hevcEnabled : !this.#h264Enabled) {
          forceFullRefresh = true;
          continue;
        }
        try {
          await this.#options.onFrame?.({
            encoding: isHEVC ? "hevc" : "h264",
            width,
            height,
            payload,
            flags: readUint32(frameHeader, 4),
          });
          this.codec = label;
        } catch (error) {
          this.reportDecoderFailure(isHEVC ? "hevc" : "h264", asError(error));
          forceFullRefresh = true;
        }
      } else if (encoding === RFB_ENCODINGS.tight) {
        if (x !== 0 || y !== 0)
          throw new Error("Crabfleet Tight updates must cover the full framebuffer");
        const control = (await this.transport.readExactly(1))[0]!;
        if ((control & 0xf0) !== 0x90)
          throw new Error(`unsupported Tight control 0x${control.toString(16)}`);
        const length = await readTightCompactLength(this.transport);
        const payload = await this.transport.readExactly(length);
        this.codec = "JPEG";
        this.#options.onTraffic?.(length);
        await this.#options.onFrame?.({ encoding: "jpeg", width, height, payload, flags: 0 });
      } else if (encoding === RFB_ENCODINGS.extendedDesktopSize) {
        const layout = await this.transport.readExactly(4);
        const screens = layout[0]!;
        if (screens > 16) throw new Error("RFB desktop layout has too many screens");
        const screenBytes = await this.transport.readExactly(screens * 16);
        if (y === 0) {
          this.width = width;
          this.height = height;
          this.#screenLayout =
            screens === 1
              ? { id: readUint32(screenBytes), flags: readUint32(screenBytes, 12) }
              : null;
          this.#options.onResize?.(width, height);
          const pending = this.#pendingResize;
          this.#pendingResize = null;
          if (pending) this.resize(pending.width, pending.height);
        }
        if (x === 1 && y !== 0) this.#options.onState?.(`Resize rejected (${y})`);
      } else {
        throw new Error(`unsupported RFB encoding ${encoding}`);
      }
    }
    if (this.#running) {
      const requestFullRefresh = forceFullRefresh || this.#forceFullRefresh;
      this.#forceFullRefresh = false;
      this.requestFramebuffer(!requestFullRefresh);
    }
  }

  async #readServerCutText(): Promise<void> {
    const header = await this.transport.readExactly(7);
    const signedLength = readInt32(header, 3);
    if (signedLength >= 0) {
      if (signedLength > maximumClipboardBytes) throw new Error("clipboard payload exceeds 1 MiB");
      const bytes = await this.transport.readExactly(signedLength);
      this.#options.onClipboard?.(decodeLatin1(bytes));
      return;
    }
    const length = -signedLength;
    if (length > maximumClipboardBytes + 65_540)
      throw new Error("extended clipboard payload is too large");
    const body = await this.transport.readExactly(length);
    try {
      await this.#handleExtendedClipboard(body);
    } catch (error) {
      this.#options.onClipboardError?.(error instanceof Error ? error.message : String(error));
    }
  }

  async #handleExtendedClipboard(body: Uint8Array): Promise<void> {
    if (body.byteLength < 4) return;
    const flags = readUint32(body);
    const action = flags & 0xff000000;
    const hasText = Boolean(flags & clipboardText);
    if (action & clipboardCaps) {
      this.#serverClipboardActions = action;
      this.#serverClipboardMaximum = hasText && body.byteLength >= 8 ? readUint32(body, 4) : 0;
    } else if (action === clipboardNotify && hasText) {
      this.transport.send(cutTextFrame(6, encodeClipboardRequest()));
    } else if (action === clipboardRequest && hasText) {
      await this.#sendClipboardProvide(this.#approvedClipboardText ?? "");
    } else if (action === clipboardPeek) {
      this.transport.send(
        cutTextFrame(6, encodeClipboardNotify(Boolean(this.#approvedClipboardText))),
      );
    } else if (action === clipboardProvide && hasText) {
      const text = await decodeClipboardProvide(body.subarray(4));
      if (text !== null) this.#options.onClipboard?.(text);
    }
  }

  async #sendClipboardProvide(text: string): Promise<void> {
    const utf8 = new TextEncoder().encode(normalizeClipboardText(text));
    if (utf8.byteLength + 1 > maximumClipboardBytes)
      throw new Error("clipboard text exceeds 1 MiB");
    if (typeof CompressionStream === "undefined") {
      const latin1 = encodeLatin1(text);
      if (latin1) {
        this.transport.send(cutTextFrame(6, latin1, false));
        return;
      }
      throw new Error("extended clipboard compression is unavailable");
    }
    const body = await encodeClipboardProvide(text);
    this.transport.send(cutTextFrame(6, body));
  }

  #enabledEncodings(): number[] {
    return [
      ...(this.#hevcEnabled ? [RFB_ENCODINGS.hevc] : []),
      ...(this.#hevcEnabled && this.#chroma444Enabled ? [RFB_ENCODINGS.chroma444] : []),
      ...(this.#h264Enabled ? [RFB_ENCODINGS.openH264] : []),
      RFB_ENCODINGS.tight,
      ...(this.#audioEnabled ? [RFB_ENCODINGS.audio] : []),
      RFB_ENCODINGS.extendedDesktopSize,
      RFB_ENCODINGS.extendedClipboard,
    ];
  }
}

export async function readRFBAudioMessage(transport: RFBTransport): Promise<RFBAudioMessage> {
  const kind = (await transport.readExactly(1))[0]!;
  if (kind === 1) {
    const header = await transport.readExactly(10);
    const format = header[0]!;
    const channels = header[1]!;
    const sampleRate = readUint32(header, 2);
    const length = readUint32(header, 6);
    if (
      format !== 1 ||
      channels < 1 ||
      channels > 2 ||
      sampleRate < 8_000 ||
      sampleRate > 192_000 ||
      length > 64 * 1_024
    )
      throw new Error("invalid CAF1 audio configuration");
    return {
      kind: "config",
      channels,
      sampleRate,
      cookie: await transport.readExactly(length),
    };
  }
  if (kind === 2) {
    const header = await transport.readExactly(10);
    const length = readUint32(header, 6);
    if (header[0] !== 0 || header[1] !== 0 || !length || length > 64 * 1_024)
      throw new Error("invalid CAF1 audio packet");
    return {
      kind: "packet",
      timestampMs: readUint32(header, 2),
      payload: await transport.readExactly(length),
    };
  }
  if (kind === 3) {
    const padding = await transport.readExactly(2);
    if (padding[0] !== 0 || padding[1] !== 0) throw new Error("invalid CAF1 audio stop");
    return { kind: "stop" };
  }
  throw new Error(`invalid CAF1 audio message kind ${kind}`);
}

export function encodeSetEncodings(encodings: readonly number[]): Uint8Array {
  return concat(new Uint8Array([2, 0]), uint16(encodings.length), ...encodings.map(uint32));
}

export function encodeTightCompactLength(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0 || length >= 1 << 22)
    throw new Error("invalid Tight length");
  const bytes: number[] = [];
  let remaining = length;
  let byte = remaining & 0x7f;
  remaining >>= 7;
  if (remaining) byte |= 0x80;
  bytes.push(byte);
  if (remaining) {
    byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  }
  if (remaining) bytes.push(remaining & 0xff);
  return new Uint8Array(bytes);
}

export async function readTightCompactLength(
  transport: Pick<RFBTransport, "readExactly">,
): Promise<number> {
  const first = (await transport.readExactly(1))[0]!;
  let result = first & 0x7f;
  if (!(first & 0x80)) return result;
  const second = (await transport.readExactly(1))[0]!;
  result |= (second & 0x7f) << 7;
  if (!(second & 0x80)) return result;
  return result | ((await transport.readExactly(1))[0]! << 14);
}

export function encodeClipboardCaps(maximumBytes: number, compression = true): Uint8Array {
  const actions = compression
    ? clipboardRequest | clipboardPeek | clipboardNotify | clipboardProvide
    : 0;
  return concat(uint32(clipboardCaps | actions | clipboardText), uint32(maximumBytes));
}

export function encodeClipboardRequest(): Uint8Array {
  return uint32(clipboardRequest | clipboardText);
}

export function encodeClipboardNotify(hasText: boolean): Uint8Array {
  return uint32(clipboardNotify | (hasText ? clipboardText : 0));
}

async function encodeClipboardProvide(text: string): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(`${normalizeClipboardText(text)}\0`);
  if (encoded.byteLength > maximumClipboardBytes) throw new Error("clipboard text exceeds 1 MiB");
  const uncompressed = concat(uint32(encoded.byteLength), encoded);
  const compressed = await transformBytes(uncompressed, new CompressionStream("deflate"));
  return concat(uint32(clipboardProvide | clipboardText), compressed);
}

export async function decodeClipboardProvide(compressed: Uint8Array): Promise<string | null> {
  if (typeof DecompressionStream === "undefined") return null;
  const bytes = await transformBytes(
    compressed,
    new DecompressionStream("deflate"),
    maximumClipboardBytes + 4,
  );
  if (bytes.byteLength < 4) return null;
  const length = readUint32(bytes);
  if (length > maximumClipboardBytes || bytes.byteLength < length + 4) return null;
  const payload = bytes.subarray(4, 4 + length);
  const nul = payload.indexOf(0);
  return new TextDecoder()
    .decode(nul >= 0 ? payload.subarray(0, nul) : payload)
    .replaceAll("\r\n", "\n");
}

async function transformBytes(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
  maximumOutputBytes = maximumClipboardBytes + 65_536,
): Promise<Uint8Array> {
  const output = readBoundedStream(stream.readable, maximumOutputBytes);
  const writer = stream.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  return await output;
}

export async function readBoundedStream(
  readable: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel("extended clipboard output exceeded limit");
      throw new Error("extended clipboard output exceeds 1 MiB");
    }
    chunks.push(value);
  }
  return concat(...chunks);
}

function normalizeClipboardText(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
}

function cutTextFrame(messageType: number, body: Uint8Array, extended = true): Uint8Array {
  const length = extended ? -body.byteLength : body.byteLength;
  return concat(new Uint8Array([messageType, 0, 0, 0]), uint32(length), body);
}

function encodeLatin1(text: string): Uint8Array | null {
  const result = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0xff) return null;
    result[index] = code;
  }
  return result;
}

function decodeLatin1(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 16_384) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return result;
}

function uint16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value);
  return bytes;
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0);
  return bytes;
}

function readUint16(bytes: Uint8Array, offset = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset);
}

function readUint32(bytes: Uint8Array, offset = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function readInt32(bytes: Uint8Array, offset = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
