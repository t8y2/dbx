import { describe, expect, it } from "vitest";
import { getSqlCompletionContext } from "@/lib/sql/sqlCompletion";
import {
  buildSqlServerUseDatabaseCompletionItems,
  mergeSqlCompletionQualifierNames,
  resolveSqlCompletionRoutineLookupTarget,
  resolveSqlCompletionSchemaLookupDatabase,
  resolveSqlCompletionScope,
  resolveSqlCompletionTableLookupTarget,
  resolveSqlServerUseDatabaseCompletion,
  sqlServerUseCompletionDatabaseNames,
} from "@/lib/sql/sqlCompletionLookupTarget";

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

  it("routes a SQL Server double-dot qualifier to the database's dbo schema", () => {
    const sql = "select * from BarDB..ord";
    const completionContext = getSqlCompletionContext(sql, sql.length, { databaseType: "sqlserver" });

    expect(completionContext).toMatchObject({
      prefix: "ord",
      qualifier: "BarDB.dbo",
      qualifierParts: ["BarDB", "dbo"],
    });
    expect(
      resolveSqlCompletionTableLookupTarget({
        currentDatabase: "FooDB",
        currentSchema: "sales",
        supportsDatabaseQualifier: false,
        supportsDatabaseSchemaQualifier: true,
        knownDatabases: ["FooDB", "BarDB"],
        completionContext,
      }),
    ).toEqual({
      database: "BarDB",
      schema: "dbo",
      filter: "ord",
      qualifierDatabase: "BarDB",
    });
  });

  it.each(["postgres", "trino", "prestosql"] as const)("does not apply SQL Server double-dot semantics to %s", (databaseType) => {
    const sql = "select * from BarDB..ord";

    expect(getSqlCompletionContext(sql, sql.length, { databaseType }).qualifierParts).toBeUndefined();
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

  it("uses the preceding SQL Server USE database and its server-reported default schema", () => {
    const sql = "USE [bardb]\n\nSELECT * FROM T";
    const completionContext = getSqlCompletionContext(sql, sql.length, { databaseType: "sqlserver", dialect: "sqlserver" });
    const scope = resolveSqlCompletionScope({
      sql,
      cursor: sql.length,
      databaseType: "sqlserver",
      currentDatabase: "FooDB",
      currentSchema: "sales",
      knownDatabases: ["FooDB", "BarDB"],
      supportsSessionDatabaseSwitch: true,
      useDatabaseDefaultSchema: "app_user",
      completionContext,
    });

    expect(scope.database).toBe("BarDB");
    expect(scope.schema).toBe("app_user");
    expect(
      resolveSqlCompletionTableLookupTarget({
        currentDatabase: scope.database,
        currentSchema: scope.schema,
        supportsDatabaseQualifier: false,
        supportsDatabaseSchemaQualifier: true,
        completionContext: scope.completionContext,
      }),
    ).toEqual({
      database: "BarDB",
      schema: "app_user",
      filter: "T",
    });
  });

  it("uses the last preceding SQL Server USE and unescapes its identifier", () => {
    const sql = "USE FooDB;\nUSE [Bar]]DB];\nSELECT * FROM T";
    const completionContext = getSqlCompletionContext(sql, sql.length, { databaseType: "sqlserver", dialect: "sqlserver" });
    const scope = resolveSqlCompletionScope({
      sql,
      cursor: sql.length,
      databaseType: "sqlserver",
      currentDatabase: "SelectedDB",
      knownDatabases: ["SelectedDB", "FooDB", "Bar]DB"],
      supportsSessionDatabaseSwitch: true,
      useDatabaseDefaultSchema: "reporting_user",
      completionContext,
    });

    expect(scope.database).toBe("Bar]DB");
  });

  it("ignores commented, quoted, current, later, and non-SQL Server USE text", () => {
    const sql = "-- USE [CommentDB]\nSELECT 'USE [StringDB]';\nSELECT * FROM T;\nUSE [LaterDB];";
    const cursor = sql.indexOf("T;") + 1;
    const completionContext = getSqlCompletionContext(sql, cursor, { databaseType: "sqlserver", dialect: "sqlserver" });

    expect(
      resolveSqlCompletionScope({
        sql,
        cursor,
        databaseType: "sqlserver",
        currentDatabase: "FooDB",
        currentSchema: "dbo",
        completionContext,
      }).database,
    ).toBe("FooDB");
    const currentUseSql = "USE [BarDB]";
    expect(
      resolveSqlCompletionScope({
        sql: currentUseSql,
        cursor: currentUseSql.length,
        databaseType: "sqlserver",
        currentDatabase: "FooDB",
        currentSchema: "dbo",
        completionContext,
      }).database,
    ).toBe("FooDB");
    expect(
      resolveSqlCompletionScope({
        sql: "USE [BarDB];\nSELECT * FROM T",
        cursor: "USE [BarDB];\nSELECT * FROM T".length,
        databaseType: "postgres",
        currentDatabase: "FooDB",
        currentSchema: "public",
        completionContext,
      }),
    ).toMatchObject({ database: "FooDB", schema: "public", completionContext });
  });

  it("scopes unqualified SQL Server references without overriding explicit databases or schemas", () => {
    const sql = "USE [BarDB];\nSELECT * FROM T";
    const completionContext = {
      ...getSqlCompletionContext(sql, sql.length, { databaseType: "sqlserver", dialect: "sqlserver" }),
      insertTable: "NewRow",
      referencedTables: [{ name: "TUser" }, { name: "TOrder", schema: "sales" }, { name: "TArchive", database: "ArchiveDB", schema: "history" }],
    };
    const scope = resolveSqlCompletionScope({
      sql,
      cursor: sql.length,
      databaseType: "sqlserver",
      currentDatabase: "FooDB",
      knownDatabases: ["FooDB", "BarDB", "ArchiveDB"],
      supportsSessionDatabaseSwitch: true,
      useDatabaseDefaultSchema: "app_user",
      completionContext,
    });

    expect(scope.completionContext).toMatchObject({
      insertDatabase: "BarDB",
      insertSchema: "app_user",
      referencedTables: [
        { name: "TUser", database: "BarDB", schema: "app_user" },
        { name: "TOrder", database: "BarDB", schema: "sales" },
        { name: "TArchive", database: "ArchiveDB", schema: "history" },
      ],
    });
  });

  it("falls back to the selected SQL Server database when USE names an unknown database", () => {
    const sql = "USE [MissingDB];\nSELECT * FROM T";
    const completionContext = getSqlCompletionContext(sql, sql.length, { databaseType: "sqlserver", dialect: "sqlserver" });
    const scope = resolveSqlCompletionScope({
      sql,
      cursor: sql.length,
      databaseType: "sqlserver",
      currentDatabase: "FooDB",
      currentSchema: "sales",
      knownDatabases: ["FooDB", "BarDB"],
      supportsSessionDatabaseSwitch: true,
      useDatabaseDefaultSchema: "dbo",
      completionContext,
    });

    expect(scope).toEqual({
      database: "FooDB",
      schema: "sales",
      completionContext,
    });
  });

  it("falls back to the selected database when the endpoint cannot switch sessions", () => {
    const sql = "USE [BarDB];\nSELECT * FROM T";
    const completionContext = getSqlCompletionContext(sql, sql.length, { databaseType: "sqlserver", dialect: "sqlserver" });

    expect(
      resolveSqlCompletionScope({
        sql,
        cursor: sql.length,
        databaseType: "sqlserver",
        currentDatabase: "AzureDB",
        currentSchema: "sales",
        knownDatabases: ["AzureDB", "BarDB"],
        supportsSessionDatabaseSwitch: false,
        useDatabaseDefaultSchema: "dbo",
        completionContext,
      }),
    ).toEqual({
      database: "AzureDB",
      schema: "sales",
      completionContext,
    });
  });

  it.each([
    ["USE ", { from: 4, prefix: "", quoteStyle: "none" }],
    ["USE Bar", { from: 4, prefix: "Bar", quoteStyle: "none" }],
    ["USE [Bar", { from: 5, prefix: "Bar", quoteStyle: "bracket" }],
    ['USE "Bar', { from: 5, prefix: "Bar", quoteStyle: "double" }],
    ["SELECT 1;\nUSE [Bar", { from: 15, prefix: "Bar", quoteStyle: "bracket" }],
  ])("resolves SQL Server database completion for %s", (sql, expected) => {
    expect(resolveSqlServerUseDatabaseCompletion({ sql, cursor: sql.length, databaseType: "sqlserver" })).toEqual(expected);
  });

  it("does not offer USE database completion outside an incomplete SQL Server USE target", () => {
    expect(resolveSqlServerUseDatabaseCompletion({ sql: "USE", cursor: 3, databaseType: "sqlserver" })).toBeUndefined();
    expect(resolveSqlServerUseDatabaseCompletion({ sql: "USE [BarDB]", cursor: 11, databaseType: "sqlserver" })).toBeUndefined();
    expect(resolveSqlServerUseDatabaseCompletion({ sql: "SELECT 'USE Bar'", cursor: 15, databaseType: "sqlserver" })).toBeUndefined();
    expect(resolveSqlServerUseDatabaseCompletion({ sql: "USE Bar", cursor: 7, databaseType: "postgres" })).toBeUndefined();
  });

  it("builds quoted SQL Server USE database completion insertions", () => {
    const unquoted = resolveSqlServerUseDatabaseCompletion({ sql: "USE Odd", cursor: 7, databaseType: "sqlserver" })!;
    const bracketed = resolveSqlServerUseDatabaseCompletion({ sql: "USE [Odd", cursor: 8, databaseType: "sqlserver" })!;
    const doubleQuoted = resolveSqlServerUseDatabaseCompletion({ sql: 'USE "Odd', cursor: 8, databaseType: "sqlserver" })!;

    expect(buildSqlServerUseDatabaseCompletionItems(["Odd]DB"], unquoted)[0]).toMatchObject({ label: "Odd]DB", detail: "database", apply: "[Odd]]DB]" });
    expect(buildSqlServerUseDatabaseCompletionItems(["Odd]DB"], bracketed)[0]).toMatchObject({ label: "Odd]DB", filterText: "Odd]]DB", apply: "Odd]]DB]" });
    expect(buildSqlServerUseDatabaseCompletionItems(['Odd"DB'], doubleQuoted)[0]).toMatchObject({ label: 'Odd"DB', filterText: 'Odd""DB', apply: 'Odd""DB"' });
  });

  it("limits USE database candidates to the current database when session switching is unsupported", () => {
    expect(
      sqlServerUseCompletionDatabaseNames({
        databaseNames: ["master", "AzureDB", "OtherDB"],
        currentDatabase: "azuredb",
        supportsSessionDatabaseSwitch: false,
      }),
    ).toEqual(["AzureDB"]);
    expect(
      sqlServerUseCompletionDatabaseNames({
        databaseNames: ["FooDB", "BarDB"],
        currentDatabase: "FooDB",
        supportsSessionDatabaseSwitch: true,
      }),
    ).toEqual(["FooDB", "BarDB"]);
    expect(
      sqlServerUseCompletionDatabaseNames({
        databaseNames: [],
        currentDatabase: "",
        supportsSessionDatabaseSwitch: false,
      }),
    ).toEqual([]);
  });

  it.each([
    ["SELECT dbo.fn_", "dbo", "fn_"],
    ["SELECT public.st_", "public", "st_"],
  ])("separates a routine schema from its name mask for %s", (sql, schema, mask) => {
    const completionContext = getSqlCompletionContext(sql, sql.length);

    expect(resolveSqlCompletionRoutineLookupTarget({ currentDatabase: "app", currentSchema: "fallback", completionContext })).toEqual({ database: "app", schema, mask });
  });

  it("uses the current schema for an unqualified routine mask", () => {
    const sql = "SELECT st_";
    const completionContext = getSqlCompletionContext(sql, sql.length);

    expect(resolveSqlCompletionRoutineLookupTarget({ currentDatabase: "app", currentSchema: "public", completionContext })).toEqual({
      database: "app",
      schema: "public",
      mask: "st_",
    });
  });

  it.each(["SELECT BarDB.sales.fn_", "EXEC BarDB.sales.proc_"])("uses an explicit SQL Server database and schema for %s", (sql) => {
    const completionContext = getSqlCompletionContext(sql, sql.length);

    expect(
      resolveSqlCompletionRoutineLookupTarget({
        currentDatabase: "FooDB",
        currentSchema: "app_user",
        supportsDatabaseSchemaQualifier: true,
        completionContext,
      }),
    ).toEqual({
      database: "BarDB",
      schema: "sales",
      mask: sql.endsWith("fn_") ? "fn_" : "proc_",
    });
  });
});
