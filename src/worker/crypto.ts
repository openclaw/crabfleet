import type { RuntimeEnv } from "./env.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sealSecret(env: RuntimeEnv, value: string): Promise<string | null> {
  const key = await secretEncryptionKey(env);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(value),
  );
  return `v1.${base64UrlFromBytes(iv)}.${base64UrlFromBytes(new Uint8Array(ciphertext))}`;
}

export async function openSecret(env: RuntimeEnv, sealed: string): Promise<string | null> {
  const [version, iv, ciphertext] = sealed.split(".");
  if (version !== "v1" || !iv || !ciphertext) return null;
  const key = await secretEncryptionKey(env);
  if (!key) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytesFromBase64Url(iv) },
      key,
      bytesFromBase64Url(ciphertext),
    );
    return decoder.decode(plaintext);
  } catch {
    return null;
  }
}

export function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function secretEncryptionKey(env: RuntimeEnv): Promise<CryptoKey | null> {
  const material = env.CRABBOX_TOKEN_ENCRYPTION_KEY || env.GITHUB_CLIENT_SECRET;
  if (!material) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`crabbox-secret-v1:${material}`),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  return base64FromBytes(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function bytesFromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
