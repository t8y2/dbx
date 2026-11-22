import { describe, expect, it, vi } from "vitest";
import { decodeSqlPluginValue, listSqlPluginCodecs, SQL_PLUGIN_CODEC_KIND, sqlPluginCodecInput, sqlPluginDecodedText } from "@/lib/dataGrid/sqlPluginCodec";
import type { InstalledPlugin } from "@/types/database";

function installed(id: string, kind: string, options: { compatible?: boolean; backend?: boolean } = {}): InstalledPlugin {
  return {
    manifest: { id, name: id, entrypoints: options.backend === false ? {} : { backend: { executable: "bin" } }, capabilities: [{ id: "decrypt", label: "Decrypt", kind }] },
    compatibility: { compatible: options.compatible ?? true },
  } as unknown as InstalledPlugin;
}

describe("sqlPluginCodec", () => {
  it("offers only compatible native plugins declaring the SQL codec capability", () => {
    const plugins = [installed("sql.codec", SQL_PLUGIN_CODEC_KIND), installed("redis.codec", "redis-value-codec-v1"), installed("old", SQL_PLUGIN_CODEC_KIND, { compatible: false }), installed("ui-only", SQL_PLUGIN_CODEC_KIND, { backend: false })];
    expect(listSqlPluginCodecs(plugins).map((codec) => [codec.pluginId, codec.codecId, codec.label])).toEqual([["sql.codec", "decrypt", "sql.codec · Decrypt"]]);
  });

  it.each([
    ["UTF-8 text", "中文 ok", {}, { ok: true, rawBase64: "5Lit5paHIG9r" }],
    ["original bytes of a binary column", "0x00ff80", { columnType: "BLOB", databaseType: "mysql" }, { ok: true, rawBase64: "AP+A" }],
    ["hex text in a text column as text", "0x00ff80", { columnType: "VARCHAR" }, { ok: true, rawBase64: "MHgwMGZmODA=" }],
    ["NULL", null, {}, { ok: false, reason: "nullValue" }],
    ["a truncated preview", "abc", { incomplete: true }, { ok: false, reason: "incomplete" }],
    ["an unreadable binary value", "not hex", { columnType: "BLOB" }, { ok: false, reason: "undecodableBinary" }],
    ["a value over 2 MiB", "a".repeat(2 * 1024 * 1024 + 1), {}, { ok: false, reason: "tooLarge" }],
  ] as const)("prepares %s", (_label, source, options, expected) => {
    expect(sqlPluginCodecInput(source, options)).toEqual(expected);
  });

  it("sends only the codec id, the bytes and column facts to the sidecar method", async () => {
    const invoke = vi.fn(async () => ({ format: "text", value: "function f() {}" }));
    const [codec] = listSqlPluginCodecs([installed("sql.codec", SQL_PLUGIN_CODEC_KIND)]);
    const context = { dbType: "oracle" as const, columnName: "SOURCE", columnType: "CLOB" };
    await expect(decodeSqlPluginValue(invoke, codec, "AP+A", context)).resolves.toEqual({ format: "text", value: "function f() {}" });
    expect(invoke).toHaveBeenCalledWith("sql.codec", "sql/codec/decode", { codecId: "decrypt", rawBase64: "AP+A", context }, 10_000);
  });

  it("rejects invalid input before invoking and invalid responses after", async () => {
    const invoke = vi.fn(async () => ({ format: "html", value: "<b>x</b>" }));
    const [codec] = listSqlPluginCodecs([installed("sql.codec", SQL_PLUGIN_CODEC_KIND)]);
    await expect(decodeSqlPluginValue(invoke, codec, "AP+", {})).rejects.toThrow("Invalid or oversized SQL codec input");
    expect(invoke).not.toHaveBeenCalled();
    await expect(decodeSqlPluginValue(invoke, codec, "AP+A", {})).rejects.toThrow("SQL codec must return json or text");
  });

  it("shows text as is and pretty-prints JSON results", () => {
    expect(sqlPluginDecodedText({ format: "text", value: "a\n  b" })).toBe("a\n  b");
    expect(sqlPluginDecodedText({ format: "json", value: { user: "Ada" } })).toBe('{\n  "user": "Ada"\n}');
  });
});
