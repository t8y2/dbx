import { describe, expect, it } from "vitest";
import { queryResultExportBaseName, sanitizeExportBaseName } from "@/lib/export/saveTextFile";

describe("queryResultExportBaseName", () => {
  it("prefers the result label derived from the SQL's nearby comment", () => {
    expect(queryResultExportBaseName("检查结果", "query 5")).toBe("检查结果");
  });

  it("falls back to the tab title when the result carries no label", () => {
    expect(queryResultExportBaseName(undefined, "query 5")).toBe("query 5");
    expect(queryResultExportBaseName("", "query 5")).toBe("query 5");
    expect(queryResultExportBaseName("   ", "query 5")).toBe("query 5");
  });

  it("keeps the schema-qualified label so exported files stay identifiable", () => {
    expect(queryResultExportBaseName("dbx.orders", "本地MySQL8.4@dbx")).toBe("dbx.orders");
  });

  it("returns undefined when neither source provides a name", () => {
    expect(queryResultExportBaseName(undefined, undefined)).toBeUndefined();
    expect(queryResultExportBaseName("", "")).toBeUndefined();
  });

  it("keeps the sanitized base name free of path separators", () => {
    expect(sanitizeExportBaseName(queryResultExportBaseName("检查结果/2026", "query 5")!)).toBe("检查结果_2026");
  });
});
