import { describe, expect, it } from "vitest";
import { deflateRawSync, deflateSync, gzipSync } from "zlib";
import { decompressRedisValue, isGzipMagic, REDIS_DECOMPRESS_MAX_OUTPUT_BYTES } from "../redisCompression";

// Decompression runs against the real pako implementation (pure JS), so these
// tests exercise the actual production path in Node the same way it runs in the
// Tauri WebView2 / WKWebView renderer — no DecompressionStream mock, no
// environment-specific behavior to paper over. node:zlib is used only to build
// fixtures (it is byte-compatible with pako for gzip/zlib/raw DEFLATE).

function gzipOf(text: string): Uint8Array {
  return new Uint8Array(gzipSync(text));
}

function zlibOf(text: string): Uint8Array {
  return new Uint8Array(deflateSync(text));
}

function deflateRawOf(data: Uint8Array | string): Uint8Array {
  return new Uint8Array(deflateRawSync(data));
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

  it("does not auto-detect raw deflate from a valid raw-deflate stream", async () => {
    // A valid raw DEFLATE stream has no framing and no checksum, so arbitrary
    // binary can look like it. Auto-detection must not accept it — regression
    // for the old behavior that fell back to raw deflate after zlib failed and
    // displayed the "decompressed" garbage as real content.
    const rawDeflate = deflateRawOf("raw deflate payload");
    const result = await decompressRedisValue(rawDeflate);
    expect(result).toEqual({ ok: false, reason: "corrupt" });
  });

  it("rejects arbitrary binary that happens to be a valid raw-deflate stream", async () => {
    // This is the exact false-positive the reviewer flagged: a value that was
    // never meant to be compressed data (a binary payload — a PNG header plus
    // non-UTF-8 bytes) gets raw-deflated, producing a structurally valid
    // bitstream. Under the old code it was accepted and shown as decompressed
    // garbage; auto-detection must now reject it.
    const binaryPayload = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x48,
      0x44,
      0x52,
      0xff,
      0x00,
      0xff,
      0x00,
      0x01,
      0x02,
      0x03,
      0x7f,
      0x80,
      0xc0,
      0xe0,
      0xfe,
    ]);
    const rawDeflate = deflateRawOf(binaryPayload);
    const result = await decompressRedisValue(rawDeflate);
    expect(result.ok).toBe(false);
  });

  it("decompresses raw deflate only when the algorithm is explicitly requested", async () => {
    const rawDeflate = deflateRawOf("explicit raw deflate payload");
    expect(await decompressRedisValue(rawDeflate)).toEqual({ ok: false, reason: "corrupt" });
    const result = await decompressRedisValue(rawDeflate, { algorithm: "deflate" });
    expect(result).toEqual({ ok: true, text: "explicit raw deflate payload", algorithm: "deflate" });
  });

  it("forces a single algorithm when requested, bypassing magic detection", async () => {
    const gz = gzipOf("gzip data");
    const zl = zlibOf("zlib data");
    // A gzip value forced as zlib must fail, and vice versa — no cross-format
    // guessing when the caller commits to an algorithm.
    expect(await decompressRedisValue(gz, { algorithm: "zlib" })).toEqual({ ok: false, reason: "corrupt" });
    expect(await decompressRedisValue(zl, { algorithm: "gzip" })).toEqual({ ok: false, reason: "corrupt" });
    expect(await decompressRedisValue(gz, { algorithm: "gzip" })).toEqual({ ok: true, text: "gzip data", algorithm: "gzip" });
    expect(await decompressRedisValue(zl, { algorithm: "zlib" })).toEqual({ ok: true, text: "zlib data", algorithm: "zlib" });
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

  it("enforces the output cap during decompression for high-ratio input", async () => {
    // 64 MiB of zeros compresses to ~64 KiB (~1000:1). The bounded inflate
    // streams output in chunks and aborts as soon as cumulative output exceeds
    // the cap — the 64 MiB is never materialized. Runs against real pako, so it
    // reflects actual platform behavior rather than a mock that buffers the
    // whole result first.
    const payload = new Uint8Array(64 * 1024 * 1024);
    const cases: Array<[Uint8Array, Parameters<typeof decompressRedisValue>[1]]> = [
      [new Uint8Array(gzipSync(payload)), undefined],
      [new Uint8Array(deflateSync(payload)), undefined],
      [deflateRawOf(payload), { algorithm: "deflate" }],
    ];
    for (const [compressed, options] of cases) {
      const result = await decompressRedisValue(compressed, { ...options, maxOutputBytes: 1024 });
      expect(result).toEqual({ ok: false, reason: "limit" });
    }
  });

  it("allows output up to exactly the cap", async () => {
    const payload = new Uint8Array(1024);
    const result = await decompressRedisValue(new Uint8Array(gzipSync(payload)), { maxOutputBytes: 1024 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.algorithm).toBe("gzip");
  });

  it("respects the shared default cap constant", () => {
    expect(REDIS_DECOMPRESS_MAX_OUTPUT_BYTES).toBe(50 * 1024 * 1024);
  });

  it("honors a custom cap below the default", async () => {
    const result = await decompressRedisValue(gzipOf("small payload"), { maxOutputBytes: 8 });
    expect(result).toEqual({ ok: false, reason: "limit" });
  });
});
