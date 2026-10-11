import { describe, expect, it } from "vitest";
import { sqlReferenceAnalysisDialectFor, sqlSemanticDialectFor } from "@/lib/sql/semantic/dialect";

describe("Snowflake semantic dialect", () => {
  it.each([undefined, "mysql", "postgres"] as const)("preserves Snowflake identifiers with fallback %s", (fallback) => {
    const dialect = sqlSemanticDialectFor({ databaseType: "snowflake", dialect: fallback });
    expect(dialect.id).toBe("snowflake");
    expect(dialect.normalizeIdentifier("Adventureworks2025")).toBe("ADVENTUREWORKS2025");
    expect(dialect.normalizeIdentifier("My.DB", true)).toBe("My.DB");
    expect(dialect.quoteIdentifier('Sales "Area"')).toBe('"Sales ""Area"""');
    expect(dialect.supportsAsForTableAlias).toBe(true);
  });
});

describe("ClickHouse semantic dialect", () => {
  it("takes precedence over the legacy MySQL behavior dialect", () => {
    const dialect = sqlSemanticDialectFor({
      databaseType: "clickhouse",
      dialect: "mysql",
    });

    expect(dialect.id).toBe("clickhouse");
    expect(dialect.identifierQuotes).toEqual([
      { open: "`", close: "`" },
      { open: '"', close: '"' },
    ]);
    expect(dialect.normalizeIdentifier("EventName")).toBe("EventName");
    expect(dialect.quoteIdentifier("event`name")).toBe("`event``name`");
  });
});

describe("SQL reference analysis dialect", () => {
  it("uses Spark SQL grammar for Kyuubi connections", () => {
    expect(
      sqlReferenceAnalysisDialectFor({
        databaseType: "kyuubi",
        identifierQuote: "`",
        fallbackDialect: "generic",
      }),
    ).toBe("spark");
  });

  it("preserves the configured fallback for other connection types", () => {
    expect(
      sqlReferenceAnalysisDialectFor({
        databaseType: "hive",
        identifierQuote: "`",
        fallbackDialect: "generic",
      }),
    ).toBe("generic");
  });
});
