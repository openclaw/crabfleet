import { badRequest } from "./http.ts";

export const terminalClipboardMaxBytes = 10 * 1024 * 1024;

export async function readTerminalClipboardBytes(request: Request): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > terminalClipboardMaxBytes) {
    throw badRequest(terminalClipboardLimitMessage());
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength) throw badRequest("clipboard file is empty");
  if (bytes.byteLength > terminalClipboardMaxBytes) {
    throw badRequest(terminalClipboardLimitMessage());
  }
  return bytes;
}

export function terminalClipboardFilename(value: unknown, mediaType: string): string {
  const raw = typeof value === "string" ? (value.split(/[\\/]/).pop() ?? "") : "";
  const base = clean(raw || `clipboard${clipboardExtension(mediaType)}`, 90)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  const fallback = `clipboard${clipboardExtension(mediaType)}`;
  const name = base || fallback;
  return name.includes(".") ? name : `${name}${clipboardExtension(mediaType)}`;
}

export function terminalClipboardLimitMessage(): string {
  return `clipboard file exceeds ${Math.floor(terminalClipboardMaxBytes / 1024 / 1024)} MiB`;
}

function clipboardExtension(mediaType: string): string {
  const normalized = (mediaType.toLowerCase().split(";")[0] ?? "").trim();
  if (normalized === "text/markdown") return ".md";
  if (normalized === "application/json") return ".json";
  if (normalized.includes("png")) return ".png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return ".jpg";
  if (normalized.includes("gif")) return ".gif";
  if (normalized.includes("webp")) return ".webp";
  if (normalized.includes("svg")) return ".svg";
  if (normalized.includes("pdf")) return ".pdf";
  if (normalized.startsWith("text/")) return ".txt";
  return ".bin";
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
