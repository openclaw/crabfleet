export const runtimeAdapterResponseBodyLimitBytes = 64 * 1024;

export class ResponseBodyLimitError extends Error {
  constructor(limit: number) {
    super(`response body exceeds ${limit} bytes`);
    this.name = "ResponseBodyLimitError";
  }
}

export async function readBoundedResponseText(
  response: Response,
  limit = runtimeAdapterResponseBodyLimitBytes,
): Promise<string> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("invalid response body limit");
  const declaredLength = response.headers.get("content-length");
  if (/^\d+$/u.test(declaredLength ?? "") && Number(declaredLength) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseBodyLimitError(limit);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (total + value.byteLength > limit) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseBodyLimitError(limit);
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
