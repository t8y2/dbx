import { describe, expect, it } from "vitest";
import { buildSqlLocalSchemaOverlay, MAX_LOCAL_SCHEMA_SQL_LENGTH } from "@/lib/sql/semantic/localSchema";

function table(sql: string, name: string, databaseType?: "postgres" | "mysql" | "sqlite") {
  const overlay = buildSqlLocalSchemaOverlay(sql, { databaseType, dialect: databaseType });
  const result = overlay.tables.find((item) => item.name === name);
  expect(result, sql).toBeDefined();
  expect(structuredClone(overlay)).toEqual(overlay);
  return result!;
}

describe("editor-local DDL schema overlay", () => {
  it.each(["postgres", "mysql", "sqlite"] as const)("reads an unexecuted CREATE TABLE for %s", (dialect) => {
    const result = table("CREATE TABLE a (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active BOOLEAN);", "a", dialect);
    expect(result.columns.map((column) => column.name)).toEqual(["id", "name", "active"]);
    expect(result.columns[0].isNullable).toBe(false);
    expect(result.columns[1].isNullable).toBe(false);
    expect(result.columns[0].span.start).toBeGreaterThan(0);
  });

  it("preserves PostgreSQL quoted identity and folds unquoted names", () => {
    const result = table('CREATE TABLE public."Mixed" ("Id" INTEGER, "DisplayName" TEXT);', "Mixed", "postgres");
    expect(result.schema).toBe("public");
    expect(result.nameQuoted).toBe(true);
    expect(result.applyName).toBe('public."Mixed"');
    expect(result.columns.map((column) => column.name)).toEqual(["Id", "DisplayName"]);
    expect(table("CREATE TABLE PUBLIC.ACCOUNT (ID INTEGER);", "account", "postgres").schema).toBe("public");
  });

  it("keeps MySQL database qualifiers and backticks", () => {
    const result = table("CREATE TABLE `app`.`Account` (`id` BIGINT UNSIGNED, `displayName` VARCHAR(255));", "Account", "mysql");
    expect(result.database).toBe("app");
    expect(result.schema).toBe("app");
    expect(result.applyName).toBe("`app`.`Account`");
    expect(result.columns.map((column) => column.name)).toEqual(["id", "displayName"]);
  });

  it("supports SQLite main and the three identifier quote forms", () => {
    const result = table('CREATE TABLE main."Mixed" ("Id" INTEGER, `name` TEXT, [active] BOOLEAN);', "Mixed", "sqlite");
    expect(result.schema).toBe("main");
    expect(result.columns.map((column) => column.name)).toEqual(["Id", "name", "active"]);
  });

  it("does not emit table-level constraints as columns", () => {
    const result = table("CREATE TABLE a (id INTEGER, name TEXT, CONSTRAINT pk_a PRIMARY KEY (id), FOREIGN KEY (id) REFERENCES b(id), UNIQUE (name), CHECK (id > 0));", "a");
    expect(result.columns.map((column) => column.name)).toEqual(["id", "name"]);
  });

  it("uses CTAS projection aliases", () => {
    const result = table("CREATE TABLE c AS SELECT 1 AS value, 2 AS total;", "c");
    expect(result.columns.map((column) => column.name)).toEqual(["value", "total"]);
  });

  it("applies ALTER ADD COLUMN without duplicating existing fields", () => {
    const result = table("CREATE TABLE a (id INTEGER);\nALTER TABLE a ADD COLUMN name TEXT;\nALTER TABLE a ADD COLUMN IF NOT EXISTS name TEXT;", "a");
    expect(result.columns.map((column) => column.name)).toEqual(["id", "name"]);
  });

  it("keeps the first duplicate definition", () => {
    const result = table("CREATE TABLE a (id INTEGER);\nCREATE TABLE a (id INTEGER, name TEXT);", "a");
    expect(result.columns.map((column) => column.name)).toEqual(["id"]);
  });

  it("uses the whole document, including forward references and non-executed DROP", () => {
    const overlay = buildSqlLocalSchemaOverlay("SELECT a.id FROM a;\nCREATE TABLE a (id INTEGER);\nDROP TABLE a;");
    expect(overlay.tables).toHaveLength(1);
    expect(overlay.tables[0].columns.map((column) => column.name)).toEqual(["id"]);
  });

  it("reads complete column prefixes from incomplete DDL", () => {
    const result = table("CREATE TABLE a (id INTEGER, name TEXT;", "a");
    expect(result.columns.map((column) => column.name)).toEqual(["id", "name"]);
  });

  it("ignores comments and strings that merely resemble DDL", () => {
    const overlay = buildSqlLocalSchemaOverlay("-- CREATE TABLE fake (id INTEGER);\nSELECT 'CREATE TABLE fake2 (id INTEGER)';\n/* CREATE TABLE fake3 (id INTEGER) */");
    expect(overlay.tables).toEqual([]);
  });

  it("skips IF NOT EXISTS before reading the table name", () => {
    const result = table("CREATE TABLE IF NOT EXISTS a (id INTEGER, name TEXT);", "a");
    expect(result.columns.map((column) => column.name)).toEqual(["id", "name"]);
  });

  it("uses a bounded full-document budget", () => {
    const sql = "CREATE TABLE a (id INTEGER);".repeat(Math.ceil((MAX_LOCAL_SCHEMA_SQL_LENGTH + 1) / "CREATE TABLE a (id INTEGER);".length));
    expect(buildSqlLocalSchemaOverlay(sql).tables).toEqual([]);
  });

  it("handles a large supported script without cross-statement leakage", () => {
    const sql = Array.from({ length: 500 }, (_, index) => `CREATE TABLE t${index} (id INTEGER, value TEXT);`).join("\n");
    const overlay = buildSqlLocalSchemaOverlay(sql);
    expect(overlay.tables).toHaveLength(500);
    expect(overlay.tables[499].columns.map((column) => column.name)).toEqual(["id", "value"]);
  });
  it("does not change completion metadata for unsupported database types", () => {
    expect(buildSqlLocalSchemaOverlay("CREATE TABLE a (id INTEGER);", { databaseType: "sqlserver", dialect: "tsql" }).tables).toEqual([]);
  });
});
