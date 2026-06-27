import { describe, expect, it } from "vitest";
import { formatSqlForDisplay, formatSqlText, MAX_SQL_FORMAT_CHARS, sqlFormatDialectForDbType } from "@/lib/sqlFormatter";

describe("sqlFormatter", () => {
  it("maps PostgreSQL-compatible database types to the postgres formatter dialect", () => {
    for (const dbType of ["postgres", "kwdb", "gaussdb", "opengauss", "questdb", "kingbase", "highgo", "vastbase", "redshift"]) {
      expect(sqlFormatDialectForDbType(dbType)).toBe("postgres");
    }
  });

  it("maps SQLite-compatible database types to the sqlite formatter dialect", () => {
    for (const dbType of ["sqlite", "rqlite", "turso"]) {
      expect(sqlFormatDialectForDbType(dbType)).toBe("sqlite");
    }
  });

  it("falls back to the postgres formatter when the generic dialect cannot parse SQL", async () => {
    const formatted = await formatSqlText("SELECT 1::int AS id;", "generic");

    expect(formatted).toContain("1::int");
    expect(formatted).toContain("AS id");
  });

  it("returns the original SQL for display when formatting fails", async () => {
    const oversizedSql = "x".repeat(MAX_SQL_FORMAT_CHARS + 1);

    await expect(formatSqlText(oversizedSql, "postgres")).rejects.toThrow("SQL is too large to format safely.");
    await expect(formatSqlForDisplay(oversizedSql, "postgres")).resolves.toBe(oversizedSql);
  });
});
