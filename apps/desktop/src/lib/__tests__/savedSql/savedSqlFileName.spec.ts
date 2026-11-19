import { describe, expect, it } from "vitest";
import { ensureSqlExtension, extractCandidateDatabaseFromName, nextAvailableSqlName, stripSqlExtension } from "@/lib/savedSql/savedSqlFileName";

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

  it("extracts candidate database from prefix with hyphen separator", () => {
    expect(extractCandidateDatabaseFromName("aisp_aikf - 全量呼入数据.sql")).toBe("aisp_aikf");
    expect(extractCandidateDatabaseFromName("prod_db - test_query.sql")).toBe("prod_db");
    expect(extractCandidateDatabaseFromName("my_db-report.sql")).toBe("my_db");
    expect(extractCandidateDatabaseFromName("F56 - ai稽核.sql")).toBe("F56");
  });

  it("returns undefined when no candidate database prefix exists", () => {
    expect(extractCandidateDatabaseFromName("query.sql")).toBeUndefined();
    expect(extractCandidateDatabaseFromName("plain_name")).toBeUndefined();
    expect(extractCandidateDatabaseFromName("最近10天转写.sql")).toBeUndefined();
  });
});

describe("nextAvailableSqlName", () => {
  it("keeps a free name unchanged", () => {
    expect(nextAvailableSqlName("query_4", new Set())).toBe("query_4.sql");
    expect(nextAvailableSqlName("query_4.sql", new Set(["other.sql"]))).toBe("query_4.sql");
  });

  it("continues an underscored counter series instead of nesting a new suffix", () => {
    expect(nextAvailableSqlName("query_3.sql", new Set(["query_3.sql"]))).toBe("query_4.sql");
    expect(nextAvailableSqlName("query_4.sql", new Set(["query_3.sql", "query_4.sql", "query_5.sql"]))).toBe("query_6.sql");
  });

  it("continues a parenthesized counter series", () => {
    expect(nextAvailableSqlName("report (2).sql", new Set(["report (2).sql"]))).toBe("report (3).sql");
    expect(nextAvailableSqlName("report(2).sql", new Set(["report(2).sql"]))).toBe("report(3).sql");
  });

  it("starts a parenthesized series for names without a counter", () => {
    expect(nextAvailableSqlName("report.sql", new Set(["report.sql"]))).toBe("report (2).sql");
    expect(nextAvailableSqlName("report.sql", new Set(["report.sql", "REPORT (2).SQL"]))).toBe("report (3).sql");
  });

  it("compares names case-insensitively and implies the .sql extension", () => {
    expect(nextAvailableSqlName("Query_7", new Set(["query_7.SQL"]))).toBe("Query_8.sql");
    expect(nextAvailableSqlName("query_7.sql", new Set(["query_7"]))).toBe("query_8.sql");
  });

  it("skips over taken names inside the series", () => {
    expect(nextAvailableSqlName("query_1.sql", new Set(["query_1.sql", "query_2.sql", "query_4.sql"]))).toBe("query_3.sql");
  });
});
