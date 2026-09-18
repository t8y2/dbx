import { describe, expect, it } from "vitest";
import { uniqueSavedSqlExportFileName } from "@/lib/savedSql/savedSqlExport";

describe("saved SQL export names", () => {
  it.each([
    ["report:daily.sql", "report:daily.sql", "report_daily (2).sql"],
    ["report_daily (2).sql", "report:daily.sql", "REPORT:DAILY.SQL"],
    ["report/daily", "report\\daily", "report_daily.sql"],
  ])("keeps all contents when sanitized names and generated suffixes collide: %j", (...names) => {
    const taken = new Set<string>();
    const output = new Map<string, string>();
    names.forEach((name, index) => {
      const path = uniqueSavedSqlExportFileName(name, taken);
      expect(path).not.toMatch(/[<>:"/\\|?*]/);
      output.set(path.toLocaleLowerCase(), `SELECT ${index};`);
    });
    expect([...output.values()]).toEqual(["SELECT 0;", "SELECT 1;", "SELECT 2;"]);
  });

  it("preserves a safe filename and adds suffixes only for collisions", () => {
    const taken = new Set<string>();
    expect(uniqueSavedSqlExportFileName("Report.SQL", taken)).toBe("Report.SQL");
    expect(uniqueSavedSqlExportFileName("report", taken)).toBe("report (2).sql");
    expect(uniqueSavedSqlExportFileName("report", taken)).toBe("report (3).sql");
  });
});
