import { describe, expect, it } from "vitest";
import { getSqlCompletionContext } from "@/lib/sql/sqlCompletion";
import { mergeSqlCompletionQualifierNames, resolveSqlCompletionRoutineLookupTarget, resolveSqlCompletionSchemaLookupDatabase, resolveSqlCompletionTableLookupTarget } from "@/lib/sql/sqlCompletionLookupTarget";

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

  it("routes a SQL Server database qualifier to schema completion", () => {
    const completionContext = getSqlCompletionContext("select * from Reporting.d", "select * from Reporting.d".length);

    expect(
      resolveSqlCompletionSchemaLookupDatabase({
        supportsDatabaseSchemaQualifier: true,
        knownDatabases: ["Default_DB", "Reporting"],
        completionContext,
      }),
    ).toBe("Reporting");
  });

  it("does not case-fold database qualifiers while choosing a schema scope", () => {
    const completionContext = getSqlCompletionContext("select * from reporting.d", "select * from reporting.d".length);

    expect(
      resolveSqlCompletionSchemaLookupDatabase({
        supportsDatabaseSchemaQualifier: true,
        knownDatabases: ["Reporting"],
        completionContext,
      }),
    ).toBeUndefined();
  });

  it("does not let a case-distinct schema hide an exact database qualifier", () => {
    const completionContext = getSqlCompletionContext("select * from reporting.d", "select * from reporting.d".length);

    expect(
      resolveSqlCompletionSchemaLookupDatabase({
        supportsDatabaseSchemaQualifier: true,
        knownDatabases: ["reporting"],
        knownSchemas: ["Reporting"],
        completionContext,
      }),
    ).toBe("reporting");
  });

  it("does not mistake a current-database schema for a database", () => {
    const completionContext = getSqlCompletionContext("select * from dbo.", "select * from dbo.".length);

    expect(
      resolveSqlCompletionSchemaLookupDatabase({
        supportsDatabaseSchemaQualifier: true,
        knownDatabases: ["Default_DB", "Reporting"],
        completionContext,
      }),
    ).toBeUndefined();
  });

  it("prefers a current-database schema when a database has the same name", () => {
    const completionContext = getSqlCompletionContext("select * from dbo.", "select * from dbo.".length);

    expect(
      resolveSqlCompletionSchemaLookupDatabase({
        supportsDatabaseSchemaQualifier: true,
        knownDatabases: ["dbo", "Reporting"],
        knownSchemas: ["dbo", "sales"],
        completionContext,
      }),
    ).toBeUndefined();
  });

  it("keeps case-distinct database and schema completion names", () => {
    expect(mergeSqlCompletionQualifierNames(["Reporting", "dbo"], ["reporting", "dbo"])).toEqual(["Reporting", "dbo", "reporting"]);
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
