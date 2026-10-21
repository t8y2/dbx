import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems } from "@/lib/sql/sqlCompletion";

describe("PostgreSQL keyword and data type completion (#12568)", () => {
  function itemsFor(sql: string, databaseType = "postgres", keywordCase?: "upper" | "lower" | "pascal") {
    return buildSqlCompletionItems(sql, sql.length, {
      databaseType: databaseType as never,
      tables: [],
      columnsByTable: new Map(),
      keywordCase,
    });
  }

  function labelsFor(sql: string, databaseType = "postgres", keywordCase?: "upper" | "lower" | "pascal") {
    return itemsFor(sql, databaseType, keywordCase).map((item) => item.label);
  }

  it("offers TIMESTAMPTZ and TIMESTAMP for the 'times' prefix in PostgreSQL", () => {
    const labels = labelsFor("times");
    expect(labels).toContain("TIMESTAMPTZ");
    expect(labels).toContain("TIMESTAMP");
  });

  it("offers TIMESTAMPTZ with 'data type' detail when creating a table in PostgreSQL DDL", () => {
    const sql = "CREATE TABLE audit_log (id BIGSERIAL PRIMARY KEY, created_at times";
    const items = itemsFor(sql);
    const timestamptzItem = items.find((item) => item.label === "TIMESTAMPTZ");

    expect(timestamptzItem).toBeDefined();
    expect(timestamptzItem?.detail).toBe("data type");
    expect(timestamptzItem?.type).toBe("keyword");
  });

  it("offers TIMETZ and INTERVAL in DDL column definitions", () => {
    const timetzLabels = labelsFor("CREATE TABLE events (event_time timet");
    expect(timetzLabels).toContain("TIMETZ");

    const intervalLabels = labelsFor("CREATE TABLE events (duration inter");
    expect(intervalLabels).toContain("INTERVAL");
  });

  it("offers INT8, INT4, and INT2 as data types in PostgreSQL DDL", () => {
    const items = itemsFor("CREATE TABLE t (col int");
    const int8Item = items.find((item) => item.label === "INT8");
    const int4Item = items.find((item) => item.label === "INT4");
    const int2Item = items.find((item) => item.label === "INT2");

    expect(int8Item?.detail).toBe("data type");
    expect(int4Item?.detail).toBe("data type");
    expect(int2Item?.detail).toBe("data type");
  });

  it("respects lowercase keyword formatting for PostgreSQL completions", () => {
    const labels = labelsFor("times", "postgres", "lower");
    expect(labels).toContain("timestamptz");
    expect(labels).toContain("timestamp");
  });

  it.each(["kingbase", "vastbase", "gaussdb", "opengauss", "redshift"])("offers TIMESTAMPTZ for %s dialect", (dialect) => {
    const labels = labelsFor("times", dialect);
    expect(labels).toContain("TIMESTAMPTZ");
  });

  it("offers TIMESTAMPTZ for DuckDB", () => {
    const labels = labelsFor("times", "duckdb");
    expect(labels).toContain("TIMESTAMPTZ");
  });
});
