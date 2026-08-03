export const REDIS_DECOMPRESS_MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

export type RedisDecompressAlgorithm = "gzip" | "zlib" | "deflate";

/** Reliable gzip header — the only compression signature we trust for auto-detection. */
export function isGzipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export type RedisDecompressResult =
  | {
      ok: true;
      text: string;
      algorithm: RedisDecompressAlgorithm;
    }
  | {
      ok: false;
      reason: "corrupt" | "limit" | "unsupported";
    };

class DecompressionLimitError extends Error {
  readonly limitBytes: number;
  constructor(limitBytes: number) {
    super(`Decompressed output exceeds ${limitBytes} bytes`);
    this.name = "DecompressionLimitError";
    this.limitBytes = limitBytes;
  }
}

function isCompressionStreamSupported(): boolean {
  return typeof DecompressionStream === "function";
}

function createSizeCapTransform(maxOutputBytes: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxOutputBytes) {
        controller.error(new DecompressionLimitError(maxOutputBytes));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

/**
 * Streaming decompression with an output cap. The cap is the primary zip-bomb
 * defense: the transform errors the stream the moment accumulated output
 * exceeds `maxOutputBytes`, so no partial result survives. Consuming the
 * readable via `Response.arrayBuffer()` attaches the error path the standard
 * way, so corrupt input surfaces as a rejected promise (not an unhandled
 * stream error).
 */
async function decompressBytes(bytes: Uint8Array, format: "gzip" | "deflate" | "deflate-raw", maxOutputBytes: number): Promise<Uint8Array> {
  const stream = new DecompressionStream(format);
  const writer = stream.writable.getWriter();
  const output = new Response(stream.readable.pipeThrough(createSizeCapTransform(maxOutputBytes))).arrayBuffer();
  try {
    await writer.write(bytes as BufferSource);
    await writer.close();
    return new Uint8Array(await output);
  } finally {
    writer.releaseLock();
  }
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Decompress Redis value bytes with the standard web formats.
 *
 * Detection order:
 * 1. gzip — reliable magic (`1f 8b`); a failure here means corrupt data.
 * 2. zlib — `DecompressionStream("deflate")` validates the RFC 1950 header and
 *    ADLER32 trailer, so a success is checksum-verified.
 * 3. raw deflate — RFC 1951, no header/checksum; attempted last because it can
 *    accept almost any deflate-shaped bitstream.
 *
 * The `ok` result carries the algorithm that actually succeeded so the UI can
 * label it (e.g. "Decompressed (zlib)").
 */
export async function decompressRedisValue(bytes: Uint8Array, options: { maxOutputBytes?: number } = {}): Promise<RedisDecompressResult> {
  const maxOutputBytes = options.maxOutputBytes ?? REDIS_DECOMPRESS_MAX_OUTPUT_BYTES;
  if (bytes.length === 0) return { ok: false, reason: "corrupt" };

  if (isGzipMagic(bytes)) {
    return decompressOne(bytes, "gzip", maxOutputBytes);
  }

  // zlib first: checksum-verified and the common Redis COMPRESS format.
  const zlibResult = await decompressOne(bytes, "deflate", maxOutputBytes);
  if (zlibResult.ok) return zlibResult;
  if (zlibResult.reason === "limit") return zlibResult;

  return decompressOne(bytes, "deflate-raw", maxOutputBytes);
}

async function decompressOne(bytes: Uint8Array, format: "gzip" | "deflate" | "deflate-raw", maxOutputBytes: number): Promise<RedisDecompressResult> {
  if (!isCompressionStreamSupported()) return { ok: false, reason: "unsupported" };
  try {
    const output = await decompressBytes(bytes, format, maxOutputBytes);
    return { ok: true, text: decodeText(output), algorithm: algorithmForFormat(format) };
  } catch (error) {
    if (error instanceof DecompressionLimitError) return { ok: false, reason: "limit" };
    return { ok: false, reason: "corrupt" };
  }
}

function algorithmForFormat(format: "gzip" | "deflate" | "deflate-raw"): RedisDecompressAlgorithm {
  if (format === "gzip") return "gzip";
  if (format === "deflate") return "zlib";
  return "deflate";
}
