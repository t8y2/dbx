import { describe, expect, it } from "vitest";
import { oracleLegacyCharset, withOracleLegacyCharset } from "./oracleLegacyCharset";

describe("Oracle legacy encoding", () => {
  it("reads saved URL options regardless of casing", () => {
    expect(oracleLegacyCharset("PREFETCH_ROWS=42&dbx_legacy_charset=zhs16gbk")).toBe("ZHS16GBK");
    expect(oracleLegacyCharset()).toBe("");
  });

  it("changes only the legacy option and preserves unrelated parameters", () => {
    const value = withOracleLegacyCharset("PREFETCH_ROWS=42&dbx_legacy_charset=AL32UTF8&DBX_LEGACY_CHARSET=AL32UTF8", "ZHS16GBK");
    const params = new URLSearchParams(value);
    expect(params.get("PREFETCH_ROWS")).toBe("42");
    expect(params.getAll("DBX_LEGACY_CHARSET")).toEqual(["ZHS16GBK"]);
    expect(params.has("dbx_legacy_charset")).toBe(false);
    expect(withOracleLegacyCharset(value, "")).toBe("PREFETCH_ROWS=42");
  });
});
