import { Inflate as PakoInflate, Z_OK } from "pako";

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
      reason: "corrupt" | "limit";
    };

export type RedisDecompressOptions = {
  maxOutputBytes?: number;
  /**
   * Force a specific compression format instead of auto-detecting.
   * Auto-detection recognizes only gzip (magic bytes) and zlib (RFC 1950 header
   * + ADLER32 checksum). Raw deflate (`"deflate"`, RFC 1951) has no framing or
   * checksum, so arbitrary binary data can be misread as valid output — pass
   * this only when the value is known to be raw DEFLATE.
   */
  algorithm?: RedisDecompressAlgorithm;
};

class DecompressionLimitError extends Error {
  readonly limitBytes: number;
  constructor(limitBytes: number) {
    super(`Decompressed output exceeds ${limitBytes} bytes`);
    this.name = "DecompressionLimitError";
    this.limitBytes = limitBytes;
  }
}

// pako windowBits per format: gzip = 31 (RFC 1952), zlib = 15 (RFC 1950),
// raw deflate = -15 (RFC 1951).
const WINDOW_BITS: Record<RedisDecompressAlgorithm, number> = {
  gzip: 31,
  zlib: 15,
  deflate: -15,
};

/**
 * Bounded inflate via pako's streaming `Inflate`. Output arrives chunk by chunk
 * through `onData`; we count it and throw the moment cumulative output exceeds
 * `maxOutputBytes`. Because pako emits chunks incrementally (its zlib strm uses
 * a fixed-size output buffer), a zip bomb aborts after the first chunks past
 * the cap — the full output is never materialized, so peak memory stays
 * ~cap + chunk + input instead of unbounded. This is an allocation-time limit,
 * unlike counting bytes only after a decompressor has already buffered the
 * whole result internally.
 */
function inflateBounded(bytes: Uint8Array, algorithm: RedisDecompressAlgorithm, maxOutputBytes: number): Uint8Array {
  const inflater = new PakoInflate({ windowBits: WINDOW_BITS[algorithm] });
  const chunks: Uint8Array[] = [];
  let total = 0;
  inflater.onData = (chunk) => {
    total += chunk.byteLength;
    if (total > maxOutputBytes) throw new DecompressionLimitError(maxOutputBytes);
    chunks.push(chunk);
  };
  inflater.push(bytes, true);
  if (inflater.err !== Z_OK) {
    throw new Error(inflater.msg || `decompression failed (status ${inflater.err})`);
  }
  return concatBytes(chunks);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Decompress Redis value bytes with the standard web formats.
 *
 * Detection order (when no `algorithm` is forced):
 * 1. gzip — reliable magic (`1f 8b`); a failure here means corrupt data.
 * 2. zlib — RFC 1950 header + ADLER32 trailer validate on success, so a
 *    successful zlib decode is checksum-verified.
 * Raw deflate (RFC 1951) is NEVER auto-detected: it has no framing or checksum,
 * so arbitrary binary can be accepted and shown, searched, or copied as
 * "decompressed" content. Callers that know a value is raw DEFLATE must pass
 * `{ algorithm: "deflate" }` explicitly.
 *
 * The `ok` result carries the algorithm that actually succeeded so the UI can
 * label it (e.g. "Decompressed (zlib)").
 */
export async function decompressRedisValue(bytes: Uint8Array, options: RedisDecompressOptions = {}): Promise<RedisDecompressResult> {
  const maxOutputBytes = options.maxOutputBytes ?? REDIS_DECOMPRESS_MAX_OUTPUT_BYTES;
  if (bytes.length === 0) return { ok: false, reason: "corrupt" };

  if (options.algorithm) {
    return decompressOne(bytes, options.algorithm, maxOutputBytes);
  }

  if (isGzipMagic(bytes)) {
    return decompressOne(bytes, "gzip", maxOutputBytes);
  }

  return decompressOne(bytes, "zlib", maxOutputBytes);
}

async function decompressOne(bytes: Uint8Array, algorithm: RedisDecompressAlgorithm, maxOutputBytes: number): Promise<RedisDecompressResult> {
  // Yield so the UI can paint the loading state before the synchronous inflate.
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    const output = inflateBounded(bytes, algorithm, maxOutputBytes);
    return { ok: true, text: decodeText(output), algorithm };
  } catch (error) {
    if (error instanceof DecompressionLimitError) return { ok: false, reason: "limit" };
    return { ok: false, reason: "corrupt" };
  }
}
