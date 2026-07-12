const encoder = new TextEncoder();

export type HttpError = Error & { status: number };

export function text(
  body: string,
  contentType: string,
  extraHeaders: HeadersInit = {},
  status = 200,
): Response {
  return new Response(body, {
    status,
    headers: {
      ...securityHeaders(contentType),
      ...extraHeaders,
      "content-length": String(encoder.encode(body).byteLength),
    },
  });
}

export function json(body: unknown, init: ResponseInit & { headers?: HeadersInit } = {}): Response {
  const textBody = JSON.stringify(body);
  return new Response(textBody, {
    ...init,
    headers: {
      ...securityHeaders("application/json; charset=utf-8", false),
      ...init.headers,
      "content-length": String(encoder.encode(textBody).byteLength),
    },
  });
}

export function redirect(location: string, headers: HeadersInit = {}): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      ...headers,
    },
  });
}

export function securityHeaders(contentType: string, cache = true): HeadersInit {
  return {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": cache ? "public, max-age=300" : "no-store",
  };
}

export function wantsMarkdown(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/markdown");
}

export async function readJson<T>(request: Request): Promise<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await request.text()) as unknown;
  } catch {
    throw badRequest("invalid json");
  }
  assertRoundTrippableJsonIntegers(parsed);
  return parsed as T;
}

export async function readBoundedJson<T>(request: Request, maximumBytes: number): Promise<T> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("invalid JSON body limit");
  }
  const declaredLength = request.headers.get("content-length");
  if (/^\d+$/u.test(declaredLength ?? "") && Number(declaredLength) > maximumBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw payloadTooLarge(`request body must be at most ${maximumBytes} bytes`);
  }
  if (!request.body) throw badRequest("invalid json");

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
        throw payloadTooLarge(`request body must be at most ${maximumBytes} bytes`);
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw badRequest("invalid json");
  }
  assertRoundTrippableJsonIntegers(parsed);
  return parsed as T;
}

export function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const [scheme, token] = authorization.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" ? clean(token, 200) : "";
}

export function bearer(token: string | undefined): string | null {
  return token ? `Bearer ${token}` : null;
}

export function cookies(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    result.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
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
