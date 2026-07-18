import type { RFBTransport } from "./client.ts";

export const fileSharingEncoding = 0x4653_4831;
export const maximumFileSharingPathBytes = 4 * 1024;
export const maximumFileSharingChunkBytes = 256 * 1024;
export const maximumFileSharingFileBytes = 512 * 1024 * 1024;
export const maximumFileSharingEntries = 1024;

export interface RFBFileEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  modificationTimeMilliseconds: number;
}

export type RFBFileSharingMessage =
  | { kind: "capability"; displayName: string; allowWrites: boolean }
  | { kind: "list"; id: number; entries: RFBFileEntry[] }
  | { kind: "chunk"; id: number; offset: number; bytes: Uint8Array; endOfFile: boolean }
  | { kind: "operation"; id: number; operation: number }
  | { kind: "error"; id: number; message: string };

export function encodeFileListRequest(id: number, path: string): Uint8Array {
  return pathRequest(1, id, path);
}

export function encodeFileGetRequest(
  id: number,
  path: string,
  offset: number,
  length: number,
): Uint8Array {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > maximumFileSharingFileBytes)
    throw new Error("invalid file offset");
  if (!Number.isInteger(length) || length < 1 || length > maximumFileSharingChunkBytes)
    throw new Error("invalid file chunk length");
  return concat(pathRequest(2, id, path), uint64(offset), uint32(length));
}

export function encodeFilePutBeginRequest(id: number, path: string, size: number): Uint8Array {
  if (!Number.isSafeInteger(size) || size < 0 || size > maximumFileSharingFileBytes)
    throw new Error("file exceeds the 512 MiB transfer limit");
  return concat(pathRequest(3, id, path), uint64(size));
}

export function encodeFilePutChunkRequest(id: number, bytes: Uint8Array): Uint8Array {
  if (!bytes.byteLength || bytes.byteLength > maximumFileSharingChunkBytes)
    throw new Error("invalid upload chunk");
  return concat(new Uint8Array([202, 4, 0, 0]), uint32(id), uint32(bytes.byteLength), bytes);
}

export function encodeFilePutEndRequest(id: number): Uint8Array {
  return concat(new Uint8Array([202, 5, 0, 0]), uint32(id));
}

export function encodeFileMkdirRequest(id: number, path: string): Uint8Array {
  return pathRequest(6, id, path);
}

export function encodeFilePutAbortRequest(id: number): Uint8Array {
  return concat(new Uint8Array([202, 7, 0, 0]), uint32(id));
}

export async function readFileSharingMessage(
  transport: Pick<RFBTransport, "readExactly">,
): Promise<RFBFileSharingMessage> {
  const header = await transport.readExactly(3);
  const kind = header[0]!;
  if (kind === 1) {
    if (header[1]! > 1 || header[2] !== 0) throw new Error("invalid FSH1 capability padding");
    const length = readUint16(await transport.readExactly(2));
    if (!length || length > maximumFileSharingPathBytes)
      throw new Error("invalid FSH1 folder name length");
    return {
      kind: "capability",
      allowWrites: header[1] === 1,
      displayName: decodeUTF8(await transport.readExactly(length)),
    };
  }
  const id = readUint32(await transport.readExactly(4));
  if (kind === 2) {
    if (header[1] !== 0 || header[2] !== 0) throw new Error("invalid FSH1 list response");
    const count = readUint16(await transport.readExactly(2));
    if (count > maximumFileSharingEntries) throw new Error("FSH1 listing exceeds entry limit");
    const entries: RFBFileEntry[] = [];
    for (let index = 0; index < count; index += 1) {
      const nameLength = readUint16(await transport.readExactly(2));
      if (!nameLength || nameLength > maximumFileSharingPathBytes)
        throw new Error("invalid FSH1 entry name");
      const name = decodeUTF8(await transport.readExactly(nameLength));
      const metadata = await transport.readExactly(20);
      if ((metadata[0] !== 0 && metadata[0] !== 1) || metadata[1] || metadata[2] || metadata[3])
        throw new Error("invalid FSH1 entry metadata");
      const size = readUint64(metadata, 4);
      if (size > maximumFileSharingFileBytes) throw new Error("FSH1 file exceeds size limit");
      entries.push({
        name,
        isDirectory: metadata[0] === 1,
        size,
        modificationTimeMilliseconds: readUint64(metadata, 12),
      });
    }
    return { kind: "list", id, entries };
  }
  if (kind === 3) {
    if (header[1] !== 0 || (header[2] !== 0 && header[2] !== 1))
      throw new Error("invalid FSH1 file chunk");
    const chunk = await transport.readExactly(12);
    const offset = readUint64(chunk);
    const length = readUint32(chunk, 8);
    if (length > maximumFileSharingChunkBytes) throw new Error("FSH1 chunk exceeds size limit");
    return {
      kind: "chunk",
      id,
      offset,
      bytes: await transport.readExactly(length),
      endOfFile: header[2] === 1,
    };
  }
  if (kind === 4) {
    if (header[1] !== 0 || ![3, 4, 5, 6, 7].includes(header[2]!))
      throw new Error("invalid FSH1 operation response");
    const messageLength = readUint16(await transport.readExactly(2));
    if (messageLength > maximumFileSharingPathBytes)
      throw new Error("FSH1 operation message is too long");
    if (messageLength) await transport.readExactly(messageLength);
    return { kind: "operation", id, operation: header[2]! };
  }
  if (kind === 255) {
    if (header[1] !== 1 || header[2] !== 0) throw new Error("invalid FSH1 error response");
    const length = readUint16(await transport.readExactly(2));
    if (length > maximumFileSharingPathBytes) throw new Error("FSH1 error is too long");
    return { kind: "error", id, message: decodeUTF8(await transport.readExactly(length)) };
  }
  throw new Error(`invalid FSH1 response kind ${kind}`);
}

function pathRequest(kind: number, id: number, path: string): Uint8Array {
  const encoded = new TextEncoder().encode(path);
  if (encoded.byteLength > maximumFileSharingPathBytes) throw new Error("file path is too long");
  return concat(new Uint8Array([202, kind, 0, 0]), uint32(id), uint16(encoded.byteLength), encoded);
}

function decodeUTF8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
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

function uint64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function readUint16(bytes: Uint8Array, offset = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset);
}

function readUint32(bytes: Uint8Array, offset = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function readUint64(bytes: Uint8Array, offset = 0): number {
  const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("FSH1 integer exceeds browser bounds");
  return number;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
