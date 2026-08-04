import { describe, expect, it } from "vitest";
import {
  extractIdentifierAt,
  extractIdentifierDetailsAt,
  isSqlCallSiteIdentifierAt,
  isSqlKeyword,
  isSqlObjectNavigationRoutineType,
  matchSqlObject,
  matchTable,
  mergeSqlObjectNavigationType,
  splitQualifiedIdentifier,
  sqlObjectHoverDetail,
  sqlObjectNavigationSourceKind,
  sqlObjectNavigationSourceName,
  sqlObjectNavigationSourceSchema,
  sqlObjectNavigationTableType,
  sqlObjectNavigationTarget,
  sqlObjectNavigationTargetFromIdentifier,
  sqlObjectNavigationTypeFromCompletionObjectType,
  sqlObjectNavigationTypeFromTableType,
} from "@/lib/sql/sqlNavigation";

describe("extractIdentifierAt", () => {
  it("extracts unquoted qualified identifiers", () => {
    const sql = "select * from MAAC00.Accounts";

    expect(extractIdentifierAt(sql, sql.indexOf("Accounts"))).toBe("MAAC00.Accounts");
  });

  it("extracts backtick-quoted qualified identifiers", () => {
    const sql = "select * from `MAAC00`.Accounts";

    expect(extractIdentifierAt(sql, sql.indexOf("Accounts"))).toBe("MAAC00.Accounts");
    expect(extractIdentifierAt(sql, sql.indexOf("MAAC00"))).toBe("MAAC00.Accounts");
  });

  it("preserves quote metadata for quoted keyword identifiers", () => {
    const sql = "SELECT * FROM `group` LIMIT 100;";

    expect(extractIdentifierDetailsAt(sql, sql.indexOf("group"))).toEqual({
      identifier: "group",
      quoted: true,
    });
    expect(matchTable(extractIdentifierAt(sql, sql.indexOf("group")) ?? "", [{ name: "group" }])).toEqual({ name: "group" });
  });

  it("marks unquoted keyword identifiers as unquoted", () => {
    const sql = "SELECT dept, COUNT(*) FROM users GROUP BY dept;";
    const extracted = extractIdentifierDetailsAt(sql, sql.indexOf("GROUP"));

    expect(extracted).toEqual({
      identifier: "GROUP",
      quoted: false,
    });
    expect(extracted && isSqlKeyword(extracted.identifier)).toBe(true);
  });

  it("extracts double-quoted qualified identifiers", () => {
    const sql = 'select * from "MAAC00"."Accounts"';

    expect(extractIdentifierAt(sql, sql.indexOf("Accounts"))).toBe("MAAC00.Accounts");
  });
});

describe("splitQualifiedIdentifier", () => {
  it("splits quoted and multi-part identifiers", () => {
    expect(splitQualifiedIdentifier('catalog."MAAC00".Accounts')).toEqual(["catalog", "MAAC00", "Accounts"]);
    expect(splitQualifiedIdentifier("`MAAC00`.Accounts")).toEqual(["MAAC00", "Accounts"]);
  });
});

describe("matchTable", () => {
  it("matches schema-qualified table identifiers", () => {
    const table = { schema: "MAAC00", name: "Accounts", type: "view" as const };

    expect(matchTable("maac00.accounts", [table])).toBe(table);
    expect(matchTable("maac00.accounts", [table])?.type).toBe("view");
  });

  it("matches catalog.schema.table identifiers against schema-scoped tables", () => {
    const table = { schema: "MAAC00", name: "Accounts" };

    expect(matchTable("catalog.maac00.accounts", [table])).toBe(table);
  });

  it("uses the database qualifier when scoped tables provide it", () => {
    const databaseA = { database: "DatabaseA", schema: "OUT", name: "orders" };
    const databaseB = { database: "DatabaseB", schema: "OUT", name: "orders" };

    expect(matchTable("[DatabaseB].[OUT].[orders]", [databaseA, databaseB])).toBe(databaseB);
  });

  it("matches quoted schema-qualified table identifiers", () => {
    const table = { schema: "MAAC00", name: "Accounts" };

    expect(matchTable("`MAAC00`.Accounts", [table])).toBe(table);
  });

  it("does not treat non-schema qualifiers as table matches", () => {
    expect(matchTable("u.users", [{ schema: "public", name: "users" }])).toBeNull();
  });
});

describe("SQL object navigation metadata", () => {
  it("preserves view type and schema for command-click navigation", () => {
    expect(sqlObjectNavigationTarget({ name: "active_users", database: "app", schema: "dbo", type: "view" })).toEqual({
      name: "active_users",
      database: "app",
      schema: "dbo",
      type: "view",
    });
  });

  it("preserves procedure package-member metadata for command-click navigation", () => {
    expect(
      sqlObjectNavigationTarget({
        name: "CALC_TAX",
        schema: "HR",
        type: "procedure",
        parentName: "PAYROLL",
        parentSchema: "HR",
        signature: "CALC_TAX(p NUMBER)",
      }),
    ).toEqual({
      name: "CALC_TAX",
      schema: "HR",
      type: "procedure",
      parentName: "PAYROLL",
      parentSchema: "HR",
      signature: "CALC_TAX(p NUMBER)",
    });
  });

  it("uses the object type in hover details", () => {
    expect(sqlObjectHoverDetail({ name: "active_users", schema: "dbo", type: "view" })).toBe("view in dbo");
    expect(sqlObjectHoverDetail({ name: "active_users_mv", schema: "dbo", type: "materialized_view" })).toBe("materialized view in dbo");
    expect(sqlObjectHoverDetail({ name: "users", schema: "dbo", type: "table" })).toBe("table in dbo");
    expect(sqlObjectHoverDetail({ name: "calc_tax", schema: "hr", type: "procedure" })).toBe("procedure in hr");
    expect(sqlObjectHoverDetail({ name: "calc_tax", type: "procedure", parentName: "payroll", parentSchema: "hr" })).toBe("procedure in hr.payroll");
  });

  it("maps navigation types to table metadata types", () => {
    expect(sqlObjectNavigationTableType({ name: "active_users", type: "view" })).toBe("VIEW");
    expect(sqlObjectNavigationTableType({ name: "active_users_mv", type: "materialized_view" })).toBe("MATERIALIZED_VIEW");
    expect(sqlObjectNavigationTableType({ name: "users", type: "table" })).toBe("TABLE");
    expect(sqlObjectNavigationSourceKind({ name: "active_users", type: "view" })).toBe("VIEW");
    expect(sqlObjectNavigationSourceKind({ name: "active_users_mv", type: "materialized_view" })).toBe("MATERIALIZED_VIEW");
    expect(sqlObjectNavigationSourceKind({ name: "users", type: "table" })).toBeUndefined();
    expect(sqlObjectNavigationSourceKind({ name: "calc_tax", type: "procedure" })).toBe("PROCEDURE");
    expect(sqlObjectNavigationSourceKind({ name: "get_version", type: "function" })).toBe("FUNCTION");
    expect(sqlObjectNavigationSourceKind({ name: "pkg_utils", type: "package" })).toBe("PACKAGE");
    // Package members open the owning package body source.
    expect(sqlObjectNavigationSourceKind({ name: "calc_tax", type: "procedure", parentName: "payroll" })).toBe("PACKAGE_BODY");
    expect(sqlObjectNavigationSourceName({ name: "calc_tax", type: "procedure", parentName: "payroll" })).toBe("payroll");
    expect(sqlObjectNavigationSourceSchema({ name: "calc_tax", type: "procedure", parentName: "payroll", parentSchema: "hr" }, "app")).toBe("hr");
    expect(isSqlObjectNavigationRoutineType("procedure")).toBe(true);
    expect(isSqlObjectNavigationRoutineType("table")).toBe(false);
  });

  it("normalizes relation metadata without collapsing materialized views", () => {
    expect(sqlObjectNavigationTypeFromTableType("BASE TABLE")).toBe("table");
    expect(sqlObjectNavigationTypeFromTableType("VIEW")).toBe("view");
    expect(sqlObjectNavigationTypeFromTableType("materialized view")).toBe("materialized_view");
    expect(sqlObjectNavigationTypeFromTableType("PROCEDURE")).toBe("procedure");
    expect(sqlObjectNavigationTypeFromCompletionObjectType("function")).toBe("function");
    expect(mergeSqlObjectNavigationType("view", "materialized_view")).toBe("materialized_view");
    expect(mergeSqlObjectNavigationType("table", "view")).toBe("view");
    expect(mergeSqlObjectNavigationType("table", "procedure")).toBe("procedure");
  });
});

describe("matchSqlObject", () => {
  it("matches unqualified standalone procedures before package members", () => {
    const standalone = { name: "CALC_TAX", schema: "HR", type: "procedure" as const };
    const packaged = { name: "CALC_TAX", schema: "HR", parentName: "PAYROLL", type: "procedure" as const };

    expect(matchSqlObject("calc_tax", [packaged, standalone])).toBe(standalone);
  });

  it("matches schema-qualified procedures", () => {
    const procedure = { name: "CALC_TAX", schema: "HR", type: "procedure" as const };
    expect(matchSqlObject("hr.calc_tax", [procedure])).toBe(procedure);
    expect(matchSqlObject("other.calc_tax", [procedure])).toBeNull();
  });

  it("matches package members as package.proc and schema.package.proc", () => {
    const member = { name: "CALC_TAX", schema: "HR", parentName: "PAYROLL", parentSchema: "HR", type: "procedure" as const };
    expect(matchSqlObject("payroll.calc_tax", [member])).toBe(member);
    expect(matchSqlObject("hr.payroll.calc_tax", [member])).toBe(member);
  });
});

describe("call-site navigation helpers", () => {
  it("detects procedure call sites after the identifier", () => {
    const sql = "BEGIN\n  PROC_STATIC_DATA_IMPORT()\nEND;";
    const pos = sql.indexOf("PROC_STATIC_DATA_IMPORT") + 3;
    expect(isSqlCallSiteIdentifierAt(sql, pos)).toBe(true);
    expect(isSqlCallSiteIdentifierAt("SELECT * FROM users", sql.indexOf("users") >= 0 ? 0 : 0)).toBe(false);
    expect(isSqlCallSiteIdentifierAt("SELECT * FROM users", "SELECT * FROM users".indexOf("users"))).toBe(false);
  });

  it("builds optimistic targets from qualified identifiers", () => {
    expect(sqlObjectNavigationTargetFromIdentifier("PROC_STATIC_DATA_IMPORT", { fallbackSchema: "APP" })).toEqual({
      name: "PROC_STATIC_DATA_IMPORT",
      schema: "APP",
      type: "procedure",
    });
    expect(sqlObjectNavigationTargetFromIdentifier("HR.CALC_TAX")).toEqual({
      name: "CALC_TAX",
      schema: "HR",
      type: "procedure",
    });
    expect(sqlObjectNavigationTargetFromIdentifier("HR.PAYROLL.CALC_TAX")).toEqual({
      name: "CALC_TAX",
      schema: "HR",
      parentName: "PAYROLL",
      parentSchema: "HR",
      type: "procedure",
    });
  });
});
