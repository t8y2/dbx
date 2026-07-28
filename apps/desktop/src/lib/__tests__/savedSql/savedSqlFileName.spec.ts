import { describe, expect, it } from "vitest";
import { ensureSqlExtension, stripSqlExtension } from "@/lib/savedSql/savedSqlFileName";

describe("savedSqlFileName", () => {
  it("appends .sql when missing", () => {
    expect(ensureSqlExtension("report")).toBe("report.sql");
  });

  it("preserves lowercase .sql extension", () => {
    expect(ensureSqlExtension("report.sql")).toBe("report.sql");
  });

  it("preserves uppercase .SQL extension without double-appending", () => {
    expect(ensureSqlExtension("report.SQL")).toBe("report.SQL");
  });

  it("strips .sql extension case-insensitively", () => {
    expect(stripSqlExtension("report.SQL")).toBe("report");
  });
});
