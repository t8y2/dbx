import { describe, expect, it } from "vitest";
import { formatSqlFileBytes, sqlFileProgressPercent } from "./sqlFileProgress";

describe("SQL file byte progress", () => {
  it.each(["running", "statementDone", "statementFailed", "error", "cancelled", "Running", "Error", "Cancelled"])("uses bytes without reporting completion for %s", (status) => {
    expect(sqlFileProgressPercent(status, 250, 1000)).toBe(25);
    expect(sqlFileProgressPercent(status, 1000, 1000)).toBe(99);
    expect(sqlFileProgressPercent(status, 1200, 1000)).toBe(99);
  });

  it.each(["done", "Done"])("completes empty files and legacy events only after %s", (status) => {
    expect(sqlFileProgressPercent(status, 0, 0)).toBe(100);
    expect(sqlFileProgressPercent(status)).toBe(100);
  });

  it("does not invent a percentage for missing or invalid totals", () => {
    expect(sqlFileProgressPercent("running")).toBeNull();
    expect(sqlFileProgressPercent("running", 50)).toBeNull();
    expect(sqlFileProgressPercent("running", undefined, 100)).toBeNull();
    expect(sqlFileProgressPercent("running", 0, 0)).toBeNull();
    expect(sqlFileProgressPercent("running", -1, 100)).toBeNull();
    expect(sqlFileProgressPercent("running", 1, Number.NaN)).toBeNull();
    expect(sqlFileProgressPercent("running", Number.POSITIVE_INFINITY, 100)).toBeNull();
    expect(sqlFileProgressPercent("running", 0, 100)).toBe(0);
  });

  it("formats byte counts for small and large files", () => {
    expect(formatSqlFileBytes(0)).toBe("0 B");
    expect(formatSqlFileBytes(512)).toBe("512 B");
    expect(formatSqlFileBytes(1536)).toBe("1.5 KB");
    expect(formatSqlFileBytes(5 * 1024 ** 3)).toBe("5.0 GB");
    expect(formatSqlFileBytes(1024 ** 4)).toBe("1.0 TB");
  });
});
