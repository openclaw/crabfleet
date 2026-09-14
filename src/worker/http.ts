const encoder = new TextEncoder();

export type HttpError = Error & { status: number };

export function text(
  body: string,
  contentType: string,
  extraHeaders: HeadersInit = {},
  status = 200,
): Response {
  const headers = responseHeaders(securityHeaders(contentType), extraHeaders);
  headers.set("content-length", String(encoder.encode(body).byteLength));
  return new Response(body, {
    status,
    headers,
  });
}

export function json(body: unknown, init: ResponseInit & { headers?: HeadersInit } = {}): Response {
  const textBody = JSON.stringify(body);
  const headers = responseHeaders(
    securityHeaders("application/json; charset=utf-8", false),
    init.headers,
  );
  headers.set("content-length", String(encoder.encode(textBody).byteLength));
  return new Response(textBody, {
    ...init,
    headers,
  });
}

export function redirect(location: string, headers: HeadersInit = {}): Response {
  return new Response(null, {
    status: 302,
    headers: responseHeaders({ location }, headers),
  });
}

function responseHeaders(defaults: HeadersInit, overrides?: HeadersInit): Headers {
  const headers = new Headers(overrides);
  for (const [name, value] of new Headers(defaults)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
}

export function securityHeaders(contentType: string, cache = true): HeadersInit {
  return {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": cache ? "public, max-age=300" : "no-store",
  };
}

export async function readJson<T>(request: Request): Promise<T> {
  let source: string;
  try {
    source = await request.text();
  } catch {
    throw badRequest("invalid json");
  }
  return parseJson<T>(source);
}

export async function readBoundedJson<T>(request: Request, maximumBytes: number): Promise<T> {
  return parseJson<T>(await readBoundedText(request, maximumBytes));
}

export async function readBoundedText(
  request: Request,
  maximumBytes: number,
  errors: { emptyBodyMessage?: string; tooLargeMessage?: string } = {},
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("invalid JSON body limit");
  }
  const tooLargeMessage =
    errors.tooLargeMessage ?? `request body must be at most ${maximumBytes} bytes`;
  const declaredLength = request.headers.get("content-length");
  if (/^\d+$/u.test(declaredLength ?? "") && Number(declaredLength) > maximumBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw payloadTooLarge(tooLargeMessage);
  }
  if (!request.body) throw badRequest(errors.emptyBodyMessage ?? "invalid json");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw payloadTooLarge(tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseJson<T>(source: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw badRequest("invalid json");
  }
  assertRoundTrippableJsonIntegerLexemes(source);
  assertRoundTrippableJsonIntegers(parsed);
  return parsed as T;
}

export function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const [scheme, token] = authorization.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" ? clean(token, 200) : "";
}

export function decodePathIdentifier(value: string | undefined): string {
  try {
    return decodeURIComponent(value ?? "");
  } catch {
    throw badRequest("invalid path identifier");
  }
}

export function cookies(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    try {
      result.set(name, decodeURIComponent(part.slice(index + 1).trim()));
    } catch {
      continue;
    }
  }
  return result;
}

export function cookie(request: Request, name: string, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function unauthorized(): HttpError {
  return httpError(401, "unauthorized");
}

export function forbidden(message: string): HttpError {
  return httpError(403, message);
}

export function conflict(message: string): HttpError {
  return httpError(409, message);
}

export function serviceUnavailable(message: string): HttpError {
  return httpError(503, message);
}

export function badRequest(message: string): HttpError {
  return httpError(400, message);
}

export function payloadTooLarge(message: string): HttpError {
  return httpError(413, message);
}

export function tooManyRequests(message: string): HttpError {
  return httpError(429, message);
}

export function notFound(message: string): HttpError {
  return httpError(404, message);
}

function httpError(status: number, message: string): HttpError {
  return Object.assign(new Error(message), { status });
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}

function assertRoundTrippableJsonIntegers(value: unknown): void {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "number") {
      if (
        !Number.isFinite(current) ||
        (Number.isInteger(current) && (!Number.isSafeInteger(current) || Object.is(current, -0)))
      ) {
        throw badRequest("json integers must be safe and round-trippable");
      }
      continue;
    }
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    for (const item of Object.values(current)) pending.push(item);
  }
}

function assertRoundTrippableJsonIntegerLexemes(source: string): void {
  const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character !== "-" && (character < "0" || character > "9")) continue;
    numberPattern.lastIndex = index;
    const match = numberPattern.exec(source);
    if (!match) continue;
    const token = match[0];
    const value = Number(token);
    if (
      Number.isInteger(value) &&
      (!Number.isSafeInteger(value) ||
        Object.is(value, -0) ||
        exactJsonInteger(token) !== String(value))
    ) {
      throw badRequest("json integers must be safe and round-trippable");
    }
    index = numberPattern.lastIndex - 1;
  }
}

function exactJsonInteger(token: string): string | null {
  const negative = token.startsWith("-");
  const unsigned = negative ? token.slice(1) : token;
  const exponentIndex = unsigned.search(/[eE]/u);
  const mantissa = exponentIndex === -1 ? unsigned : unsigned.slice(0, exponentIndex);
  const exponentText = exponentIndex === -1 ? "" : unsigned.slice(exponentIndex + 1);
  const decimalIndex = mantissa.indexOf(".");
  const integerDigits = decimalIndex === -1 ? mantissa.length : decimalIndex;
  const digits =
    decimalIndex === -1
      ? mantissa
      : mantissa.slice(0, decimalIndex) + mantissa.slice(decimalIndex + 1);
  if (/^0+$/u.test(digits)) return negative ? "-0" : "0";

  const exponent = exponentText ? Number(exponentText) : 0;
  if (!Number.isSafeInteger(exponent)) return null;
  const decimalPosition = integerDigits + exponent;
  if (decimalPosition <= 0) return null;
  if (decimalPosition < digits.length && !/^0+$/u.test(digits.slice(decimalPosition))) {
    return null;
  }
  const exactDigits =
    decimalPosition >= digits.length
      ? digits + "0".repeat(decimalPosition - digits.length)
      : digits.slice(0, decimalPosition);
  const canonicalDigits = exactDigits.replace(/^0+/u, "") || "0";
  return negative ? `-${canonicalDigits}` : canonicalDigits;
}
