import { describe, expect, it } from "vitest";
import { getSqlCompletionContext } from "@/lib/sql/sqlCompletion";
import { resolveSqlCompletionRoutineLookupTarget, resolveSqlCompletionTableLookupTarget } from "@/lib/sql/sqlCompletionLookupTarget";

describe("sqlCompletionLookupTarget", () => {
  it("treats qualified table completion as a database lookup for MySQL-compatible engines", () => {
    const target = resolveSqlCompletionTableLookupTarget({
      currentDatabase: "default_db",
      supportsDatabaseQualifier: true,
      completionContext: {
        qualifier: "game_data",
        prefix: "",
        suggestTables: true,
      },
    });

    expect(target).toEqual({
      database: "game_data",
      filter: "",
      qualifierDatabase: "game_data",
    });
  });

  it("preserves the known database casing when the qualifier matches locally", () => {
    const target = resolveSqlCompletionTableLookupTarget({
      currentDatabase: "default_db",
      supportsDatabaseQualifier: true,
      knownDatabases: ["Game_Data"],
      completionContext: {
        qualifier: "game_data",
        prefix: "ord",
        suggestTables: true,
      },
    });

    expect(target).toEqual({
      database: "Game_Data",
      filter: "ord",
      qualifierDatabase: "Game_Data",
    });
  });

  it("keeps schema-aware qualified table completion scoped to the schema", () => {
    const target = resolveSqlCompletionTableLookupTarget({
      currentDatabase: "app",
      currentSchema: "public",
      supportsDatabaseQualifier: false,
      completionContext: {
        qualifier: "sales",
        prefix: "ord",
        suggestTables: true,
      },
    });

    expect(target).toEqual({
      database: "app",
      schema: "sales",
      filter: "ord",
    });
  });

  it.each(["sqlserver", "trino", "prestosql"])("routes %s three-part table completion to the qualified database or catalog", () => {
    const target = resolveSqlCompletionTableLookupTarget({
      currentDatabase: "default_db",
      currentSchema: "dbo",
      supportsDatabaseQualifier: false,
      supportsDatabaseSchemaQualifier: true,
      knownDatabases: ["Reporting"],
      completionContext: {
        qualifier: "reporting.OUT",
        qualifierParts: ["reporting", "OUT"],
        prefix: "ord",
        suggestTables: true,
      },
    });

    expect(target).toEqual({
      database: "Reporting",
      schema: "OUT",
      filter: "ord",
      qualifierDatabase: "Reporting",
    });
  });

  it("keeps PostgreSQL schema completion in the current database", () => {
    const target = resolveSqlCompletionTableLookupTarget({
      currentDatabase: "app",
      currentSchema: "public",
      supportsDatabaseQualifier: false,
      supportsDatabaseSchemaQualifier: false,
      completionContext: {
        qualifier: "sales",
        qualifierParts: ["sales"],
        prefix: "ord",
        suggestTables: true,
      },
    });

    expect(target).toEqual({ database: "app", schema: "sales", filter: "ord" });
  });

  it("uses the current schema for unqualified table completion", () => {
    const target = resolveSqlCompletionTableLookupTarget({
      currentDatabase: "app",
      currentSchema: "public",
      supportsDatabaseQualifier: true,
      completionContext: {
        prefix: "ord",
        suggestTables: true,
      },
    });

    expect(target).toEqual({
      database: "app",
      schema: "public",
      filter: "ord",
    });
  });

  it.each([
    ["SELECT dbo.fn_", "dbo", "fn_"],
    ["SELECT public.st_", "public", "st_"],
  ])("separates a routine schema from its name mask for %s", (sql, schema, mask) => {
    const completionContext = getSqlCompletionContext(sql, sql.length);

    expect(resolveSqlCompletionRoutineLookupTarget({ currentSchema: "fallback", completionContext })).toEqual({ schema, mask });
  });

  it("uses the current schema for an unqualified routine mask", () => {
    const sql = "SELECT st_";
    const completionContext = getSqlCompletionContext(sql, sql.length);

    expect(resolveSqlCompletionRoutineLookupTarget({ currentSchema: "public", completionContext })).toEqual({
      schema: "public",
      mask: "st_",
    });
  });
});
