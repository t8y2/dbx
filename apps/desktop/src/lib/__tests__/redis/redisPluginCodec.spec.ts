import { describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "@/types/database";
import { decodeRedisPluginValue, listRedisPluginCodecs, REDIS_PLUGIN_CODEC_KIND, validateRedisPluginBytes, validateRedisPluginResult } from "@/lib/redis/redisPluginCodec";

const installed = (id = "example.codec", compatible = true): InstalledPlugin => ({
  manifest: { id, name: id, drivers: [], entrypoints: { backend: { executable: "bin/codec" } }, capabilities: [{ id: "custom", label: "Custom", kind: REDIS_PLUGIN_CODEC_KIND }] },
  compatibility: { compatible },
});

describe("Redis plugin codecs", () => {
  it("offers only compatible native plugins declaring the versioned codec capability", () => {
    const noBackend = installed("frontend");
    noBackend.manifest.entrypoints = {};
    const other = installed("other");
    other.manifest.capabilities![0]!.kind = "unrelated";
    expect(listRedisPluginCodecs([installed(), installed("old", false), noBackend, other]).map((codec) => codec.pluginId)).toEqual(["example.codec"]);
  });

  it("passes binary bytes unchanged and only the selected non-secret context", async () => {
    const invoke = vi.fn().mockResolvedValue({ format: "json", value: { user: "Ada" } });
    const codec = listRedisPluginCodecs([installed()])[0]!;
    const context = { db: 2, keyRaw: "dXNlcjox", redisType: "hash" };
    expect(await decodeRedisPluginValue(invoke, codec, "AP+A", context)).toEqual({ format: "json", value: { user: "Ada" } });
    expect(invoke).toHaveBeenCalledWith("example.codec", "redis/codec/decode", { codecId: "custom", rawBase64: "AP+A", context }, 10000);
  });

  it("rejects malformed, non-canonical and oversized bytes before invoking a program", async () => {
    const invoke = vi.fn();
    const codec = listRedisPluginCodecs([installed()])[0]!;
    for (const raw of ["!", "YQ", "YR==", "YQ==\n", "A".repeat(3 * 1024 * 1024)]) {
      await expect(decodeRedisPluginValue(invoke, codec, raw, { db: 0, keyRaw: "", redisType: "string" })).rejects.toThrow();
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(() => validateRedisPluginBytes("")).not.toThrow();
  });

  it("validates renderer formats and bounds, including escaped text and JSON primitives", () => {
    for (const value of [null, false, 0, "", [], {}]) expect(validateRedisPluginResult({ format: "json", value }).value).toEqual(value);
    expect(validateRedisPluginResult({ format: "text", value: "<script>test</script>" }).value).toBe("<script>test</script>");
    for (const invalid of [null, {}, { format: "html", value: "x" }, { format: "text", value: 1 }, { format: "json" }, { format: "text", value: "\0".repeat(400000) }]) expect(() => validateRedisPluginResult(invalid)).toThrow();
  });
});
