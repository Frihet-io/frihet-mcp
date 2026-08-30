export type BoundedRequestBodyErrorCode =
  | "invalid_length"
  | "invalid_utf8"
  | "too_large";

export class BoundedRequestBodyError extends Error {
  readonly code: BoundedRequestBodyErrorCode;

  constructor(code: BoundedRequestBodyErrorCode) {
    super(code);
    this.name = "BoundedRequestBodyError";
    this.code = code;
  }
}

export type BoundedTextRequest = {
  request: Request;
  text: string;
  sizeBytes: number;
};

async function cancelBody(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch {
    // Best effort only. The response still fails closed before parsing.
  }
}

/**
 * Consume one request body with a real byte limit and rebuild the request.
 * `Content-Length` is only an early-rejection hint: the streamed bytes are
 * always counted, including when the header is absent or dishonest.
 */
export async function readBoundedTextRequest(
  request: Request,
  maxBytes: number,
): Promise<BoundedTextRequest> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative safe integer");
  }

  const declaredRaw = request.headers.get("content-length");
  let declaredLength: number | undefined;
  if (declaredRaw !== null) {
    if (!/^\d+$/u.test(declaredRaw)) {
      await cancelBody(request);
      throw new BoundedRequestBodyError("invalid_length");
    }
    declaredLength = Number(declaredRaw);
    if (!Number.isSafeInteger(declaredLength)) {
      await cancelBody(request);
      throw new BoundedRequestBodyError("invalid_length");
    }
    if (declaredLength > maxBytes) {
      await cancelBody(request);
      throw new BoundedRequestBodyError("too_large");
    }
  }

  const chunks: Uint8Array[] = [];
  let sizeBytes = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sizeBytes += value.byteLength;
        if (sizeBytes > maxBytes) {
          await reader.cancel();
          throw new BoundedRequestBodyError("too_large");
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof BoundedRequestBodyError) throw error;
      try {
        await reader.cancel();
      } catch {
        // Preserve the original stream failure.
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  if (declaredLength !== undefined && declaredLength !== sizeBytes) {
    throw new BoundedRequestBodyError("invalid_length");
  }

  const bytes = new Uint8Array(sizeBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new BoundedRequestBodyError("invalid_utf8");
  }

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const rebuilt = new Request(request, {
    headers,
    body: bytes,
  });
  return { request: rebuilt, text, sizeBytes };
}
