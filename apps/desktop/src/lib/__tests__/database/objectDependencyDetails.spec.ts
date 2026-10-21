import { describe, expect, it } from "vitest";
import { isObjectDependencySection, objectDependencyNavigation, objectDependencyRows, objectDependencySql, objectDependencyTarget, type ObjectDependencyRow } from "@/lib/database/objectDependencyDetails";
import { oracleObjectDependenciesSql } from "@/lib/database/oracleObjectDependencies";
import { normalizeOracleNavigationTarget, sqlObjectNavigationContextTarget, sqlObjectNavigationSourceKind } from "@/lib/sql/sqlNavigation";
import type { QueryResult, QueryTab } from "@/types/database";

const details = { connectionId: "original", database: "ORCL", schema: "Mixed.Schema", name: "Mixed.P", objectType: "PROCEDURE" as const, section: "dependencies" as const };
const row: ObjectDependencyRow = { direction: "DEPENDS_ON", name: "Mixed.Table", schema: "Other.Schema", type: "TABLE", dependencyType: "HARD", link: "", sourceType: "PROCEDURE" };

describe("object dependency details", () => {
  it("keeps captured identity and reuses the provider SQL without changing quoting or package scope", () => {
    const target = objectDependencyTarget(details, "oceanbase-oracle")!;
    expect(target).toEqual({ connectionId: "original", database: "ORCL", schema: "Mixed.Schema", name: "Mixed.P", objectType: "PROCEDURE" });
    expect(objectDependencySql(target)).toBe(oracleObjectDependenciesSql({ schema: details.schema, objectName: details.name, objectType: "PROCEDURE" }));
    expect(objectDependencyTarget({ ...details, objectType: "PACKAGE_BODY" }, "oracle")?.objectType).toBe("PACKAGE");
    expect(objectDependencyTarget(details, "xugu")).toBeUndefined();
    expect(objectDependencyTarget({ ...details, objectType: "TYPE" }, "oracle")).toBeUndefined();
  });

  it("maps both directions from column names, retaining package body origin and nullable links", () => {
    const result: QueryResult = {
      columns: ["referenced_name", "direction", "object_owner", "object_name", "object_type", "referenced_owner", "referenced_type", "dependency_type", "referenced_link_name"],
      rows: [
        ["Mixed.Table", "DEPENDS_ON", "APP", "PK", "PACKAGE BODY", "Other.Schema", "TABLE", "HARD", null],
        ["PK", "REFERENCED_BY", "CALLER", "Use.PK", "FUNCTION", "APP", "PACKAGE", "REF", null],
      ],
      affected_rows: 0,
      execution_time_ms: 1,
    };
    expect(objectDependencyRows(result)).toEqual([
      { ...row, sourceType: "PACKAGE BODY" },
      { direction: "REFERENCED_BY", name: "Use.PK", schema: "CALLER", type: "FUNCTION", dependencyType: "REF", sourceType: "FUNCTION", link: "" },
    ]);
    expect(() => objectDependencyRows({ ...result, columns: [] })).toThrow("column layout");
    expect(() => objectDependencyRows({ ...result, rows: [["x", "OTHER"]] })).toThrow("direction");
  });

  it.each(["TYPE", "TYPE BODY", "NON-EXISTENT", "UNKNOWN"])("preserves %s without incorrectly opening a table", (type) => {
    expect(objectDependencyNavigation({ ...row, type })).toBeUndefined();
  });

  it("does not open DBLink objects locally and preserves exact quoted names for supported source kinds", () => {
    expect(objectDependencyNavigation({ ...row, link: "REMOTE" })).toBeUndefined();
    expect(objectDependencyNavigation(row)).toEqual({ name: row.name, schema: row.schema, type: "table", nameQuoted: true, schemaQuoted: true });
    expect(sqlObjectNavigationContextTarget(objectDependencyNavigation(row)!, { ...details, catalog: "Original.Catalog" })).toEqual({ connectionId: "original", database: "ORCL", catalog: "Original.Catalog", schema: "Other.Schema", tableName: "Mixed.Table", tableType: "TABLE" });
    for (const [type, sourceKind] of [
      ["PACKAGE", "PACKAGE"],
      ["PACKAGE BODY", "PACKAGE_BODY"],
      ["SEQUENCE", "SEQUENCE"],
      ["PROCEDURE", "PROCEDURE"],
      ["FUNCTION", "FUNCTION"],
      ["TRIGGER", "TRIGGER"],
      ["VIEW", "VIEW"],
      ["MATERIALIZED VIEW", "MATERIALIZED_VIEW"],
    ] as const) {
      const navigation = normalizeOracleNavigationTarget(objectDependencyNavigation({ ...row, type })!);
      expect(sqlObjectNavigationSourceKind(navigation)).toBe(sourceKind);
      expect(navigation.name).toBe(row.name);
      expect(navigation.schema).toBe(row.schema);
    }
  });

  it("blocks hidden-source execution only while the captured context still matches", () => {
    const tab = { ...details, id: "source", title: "source", sql: "draft", mode: "query", isExecuting: false, isExplaining: false, isCancelling: false, objectDetails: { ...details } } as QueryTab;
    expect(isObjectDependencySection(tab)).toBe(true);
    expect(isObjectDependencySection({ ...tab, schema: "DIFFERENT" })).toBe(false);
    expect(isObjectDependencySection({ ...tab, connectionId: "new" })).toBe(false);
    expect(isObjectDependencySection({ ...tab, objectDetails: { ...details, section: "source" } })).toBe(false);
  });
});
