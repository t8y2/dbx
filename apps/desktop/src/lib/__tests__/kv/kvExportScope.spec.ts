import { describe, expect, it } from "vitest";
import { isKeyInKvExportScope, kvDirectoryPrefix, kvExportFilenameStem, kvValueByteIdentity } from "@/lib/kv/kvExportScope";

describe("KV export scope", () => {
  it("matches a directory itself and descendants without leaking into adjacent prefixes", () => {
    const scope = { path: "/dbx", kind: "prefix" as const };

    expect(isKeyInKvExportScope("/dbx", scope)).toBe(true);
    expect(isKeyInKvExportScope("/dbx/app/name", scope)).toBe(true);
    expect(isKeyInKvExportScope("/dbx-other", scope)).toBe(false);
  });

  it("matches only the selected key for a key export", () => {
    const scope = { path: "dbx/key", kind: "key" as const };

    expect(isKeyInKvExportScope("dbx/key", scope)).toBe(true);
    expect(isKeyInKvExportScope("dbx/key/child", scope)).toBe(false);
  });

  it("builds stable directory prefixes and safe filenames", () => {
    expect(kvDirectoryPrefix("/dbx")).toBe("/dbx/");
    expect(kvDirectoryPrefix("dbx/")).toBe("dbx/");
    expect(kvExportFilenameStem("/应用 配置/prod")).toBe("应用-配置-prod");
    expect(kvExportFilenameStem("/")).toBe("root");
  });

  it("compares UTF-8 and Base64 representations by their original bytes", () => {
    expect(kvValueByteIdentity({ encoding: "utf8", data: "/dbx/app" })).toBe(kvValueByteIdentity({ encoding: "base64", data: "L2RieC9hcHA=" }));
    expect(kvValueByteIdentity({ encoding: "utf8", data: "/dbx/app" })).not.toBe(kvValueByteIdentity({ encoding: "utf8", data: "/dbx-other" }));
  });
});
