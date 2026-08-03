import { beforeEach, describe, expect, it } from "vitest";
import { gunzipSync, inflateRawSync, inflateSync } from "zlib";
import { decompressRedisValue, isGzipMagic, REDIS_DECOMPRESS_MAX_OUTPUT_BYTES } from "../redisCompression";

// NOTE: Node 22's real DecompressionStream adapter crashes the process on
// corrupt input (unhandled internal zlib 'error' event) even when the reader
// error is caught, so it cannot be exercised in vitest. Production runs in a
// browser engine (Tauri WebView2 / WKWebView) where the Compression Streams
// spec contract holds — reader errors are plain TypeError rejections. These
// tests install a spec-faithful mock of DecompressionStream (ReadableStream +
// WritableStream backed by node:zlib) to exercise the logic under test: gzip
// detection, zlib→raw fallback order, the output cap, and error mapping.
// The mock is defined after the production import so it is the only
// `DecompressionStream` global the code under test sees.

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

class MockDecompressionStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  constructor(format: string) {
    const chunks: Uint8Array[] = [];
    let readableController!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({
      start(controller) {
        readableController = controller;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
      close() {
        try {
          const input = concatBytes(chunks);
          let output: Uint8Array;
          if (format === "gzip") output = new Uint8Array(gunzipSync(input));
          else if (format === "deflate") output = new Uint8Array(inflateSync(input));
          else if (format === "deflate-raw") output = new Uint8Array(inflateRawSync(input));
          else throw new Error(`Unsupported format: ${format}`);
          readableController.enqueue(output);
          readableController.close();
        } catch (cause) {
          readableController.error(new TypeError("Decompression failed", { cause }));
        }
      },
    });
  }
}

beforeEach(() => {
  (globalThis as unknown as { DecompressionStream: unknown }).DecompressionStream = MockDecompressionStream;
});

function gzipOf(text: string): Uint8Array {
  const zlib = require("zlib") as typeof import("zlib");
  return new Uint8Array(zlib.gzipSync(text));
}

function zlibOf(text: string): Uint8Array {
  const zlib = require("zlib") as typeof import("zlib");
  return new Uint8Array(zlib.deflateSync(text));
}

function deflateRawOf(text: string): Uint8Array {
  const zlib = require("zlib") as typeof import("zlib");
  return new Uint8Array(zlib.deflateRawSync(text));
}

describe("isGzipMagic", () => {
  it("detects the gzip header", () => {
    expect(isGzipMagic(gzipOf("hello"))).toBe(true);
  });

  it("rejects non-gzip payloads", () => {
    expect(isGzipMagic(new Uint8Array([0x78, 0x9c, 0x01, 0x00]))).toBe(false);
    expect(isGzipMagic(new Uint8Array(0))).toBe(false);
    expect(isGzipMagic(new Uint8Array([0x1f]))).toBe(false);
  });
});

describe("decompressRedisValue", () => {
  it("decompresses gzip via magic detection", async () => {
    const result = await decompressRedisValue(gzipOf('{"a":1}'));
    expect(result).toEqual({ ok: true, text: '{"a":1}', algorithm: "gzip" });
  });

  it("decompresses zlib-wrapped deflate", async () => {
    const result = await decompressRedisValue(zlibOf("hello world"));
    expect(result).toEqual({ ok: true, text: "hello world", algorithm: "zlib" });
  });

  it("decompresses raw deflate after zlib fails", async () => {
    const result = await decompressRedisValue(deflateRawOf("raw deflate payload"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("raw deflate payload");
      expect(result.algorithm).toBe("deflate");
    }
  });

  it("reports corrupt data without throwing", async () => {
    const result = await decompressRedisValue(new Uint8Array([0x1f, 0x8b, 0x00, 0x00, 0x00]));
    expect(result).toEqual({ ok: false, reason: "corrupt" });
  });

  it("reports corrupt for plain text that is not compressed", async () => {
    const result = await decompressRedisValue(new TextEncoder().encode("just plain text"));
    expect(result.ok).toBe(false);
  });

  it("reports corrupt for empty input", async () => {
    const result = await decompressRedisValue(new Uint8Array(0));
    expect(result).toEqual({ ok: false, reason: "corrupt" });
  });

  it("rejects output beyond the configured cap and keeps no partial content", async () => {
    // 8 MiB of zeros compresses to a few KB; decompressing it must trip the 1 KiB cap.
    const payload = new Uint8Array(8 * 1024 * 1024);
    const gz = new Uint8Array((require("zlib") as typeof import("zlib")).gzipSync(payload));
    const result = await decompressRedisValue(gz, { maxOutputBytes: 1024 });
    expect(result).toEqual({ ok: false, reason: "limit" });
  });

  it("respects the shared default cap constant", () => {
    expect(REDIS_DECOMPRESS_MAX_OUTPUT_BYTES).toBe(50 * 1024 * 1024);
  });

  it("honors a custom cap below the default", async () => {
    const result = await decompressRedisValue(gzipOf("small payload"), { maxOutputBytes: 8 });
    expect(result).toEqual({ ok: false, reason: "limit" });
  });

  it("reports unsupported when DecompressionStream is absent", async () => {
    (globalThis as unknown as { DecompressionStream: unknown }).DecompressionStream = undefined;
    const result = await decompressRedisValue(gzipOf("hello"));
    expect(result).toEqual({ ok: false, reason: "unsupported" });
  });
});
