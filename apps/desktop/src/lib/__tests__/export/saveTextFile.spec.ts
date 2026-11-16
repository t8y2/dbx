import { describe, expect, it } from "vitest";
import { DEFAULT_QUERY_RESULT_EXPORT_FILE_NAME_SOURCE, normalizeQueryResultExportFileNameSource, queryResultExportBaseName, sanitizeExportBaseName } from "@/lib/export/saveTextFile";

describe("queryResultExportBaseName", () => {
  it("prefers the result label derived from the SQL's nearby comment by default (#9894)", () => {
    expect(queryResultExportBaseName("检查结果", "query 5")).toBe("检查结果");
    expect(queryResultExportBaseName("检查结果", "query 5", "result-label")).toBe("检查结果");
  });

  it("prefers the tab title when configured to prefer tab title (#12092)", () => {
    expect(queryResultExportBaseName("orders", "sales_report.sql", "tab-title")).toBe("sales_report.sql");
    expect(sanitizeExportBaseName(queryResultExportBaseName("orders", "sales_report.sql", "tab-title")!)).toBe("sales_report");
  });

  it("falls back to the result label in tab-title mode when tab title is missing (#12092)", () => {
    expect(queryResultExportBaseName("orders", undefined, "tab-title")).toBe("orders");
    expect(queryResultExportBaseName("orders", "", "tab-title")).toBe("orders");
    expect(queryResultExportBaseName("orders", "   ", "tab-title")).toBe("orders");
  });

  it("falls back to the tab title when the result carries no label in result-label mode", () => {
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
    expect(queryResultExportBaseName(undefined, undefined, "tab-title")).toBeUndefined();
    expect(queryResultExportBaseName("", "", "tab-title")).toBeUndefined();
  });

  it("keeps the sanitized base name free of path separators", () => {
    expect(sanitizeExportBaseName(queryResultExportBaseName("检查结果/2026", "query 5")!)).toBe("检查结果_2026");
  });
});

describe("normalizeQueryResultExportFileNameSource", () => {
  it("accepts valid export filename source values", () => {
    expect(normalizeQueryResultExportFileNameSource("result-label")).toBe("result-label");
    expect(normalizeQueryResultExportFileNameSource("tab-title")).toBe("tab-title");
  });

  it("falls back to default on invalid or missing values", () => {
    expect(normalizeQueryResultExportFileNameSource(undefined)).toBe(DEFAULT_QUERY_RESULT_EXPORT_FILE_NAME_SOURCE);
    expect(normalizeQueryResultExportFileNameSource("invalid")).toBe(DEFAULT_QUERY_RESULT_EXPORT_FILE_NAME_SOURCE);
    expect(normalizeQueryResultExportFileNameSource(123)).toBe(DEFAULT_QUERY_RESULT_EXPORT_FILE_NAME_SOURCE);
  });
});
