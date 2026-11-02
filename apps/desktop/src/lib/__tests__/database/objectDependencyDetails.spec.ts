import { describe, expect, it } from "vitest";
import { isObjectDependencySection, objectDependencyNavigation, objectDependencyRows, objectDependencySql, objectDependencyTarget, objectRelationKinds, objectForeignKeyRows, objectOwnershipRows, relationObjectNavigation, type ObjectDependencyRow } from "@/lib/database/objectDependencyDetails";
import { oracleObjectDependenciesSql } from "@/lib/database/oracleObjectDependencies";
import { normalizeOracleNavigationTarget, sqlObjectNavigationContextTarget, sqlObjectNavigationSourceKind } from "@/lib/sql/sqlNavigation";
import type { QueryResult, QueryTab, TriggerInfo } from "@/types/database";

const details = { connectionId: "original", database: "ORCL", schema: "Mixed.Schema", name: "Mixed.P", objectType: "PROCEDURE" as const, section: "dependencies" as const };
const row: ObjectDependencyRow = { direction: "DEPENDS_ON", name: "Mixed.Table", schema: "Other.Schema", type: "TABLE", dependencyType: "HARD", link: "", sourceType: "PROCEDURE" };

describe("object dependency details", () => {
  it("uses the existing dependency query only for a matching exact DM8 trigger, never DM routines or a compatibility label", () => {
    const trigger: TriggerInfo = { name: " Tr'ig ", timing: "BEFORE", event: "INSERT", oracle_metadata: { contractVersion: 1, identityMode: "exact", engine: "dm", engineVersion: "8.1.3", owner: " Owner ", name: " Tr'ig ", objectId: "trigger-id", scope: "TABLE", reads: {} } };
    const triggerDetails = { ...details, schema: " Owner ", name: trigger.name, objectType: "TRIGGER" as const, catalog: " Catalog " };
    const target = objectDependencyTarget(triggerDetails, "dameng", trigger);
    expect(target).toEqual({ connectionId: details.connectionId, database: details.database, schema: " Owner ", name: " Tr'ig ", objectType: "TRIGGER", catalog: " Catalog ", databaseType: "dameng" });
    expect(objectRelationKinds(target!)).toEqual(["dependencies"]);
    expect(() => objectDependencySql(target!, "ownership")).toThrow("not supported");
    expect(() => objectDependencySql(target!, "foreignKeys")).toThrow("not supported");
    expect(objectDependencySql(target!)).toContain("d.NAME = ' Tr''ig '");
    expect(objectDependencySql(target!)).toContain("d.TYPE = 'TRIGGER'");
    expect(objectDependencySql(target!)).toContain("d.REFERENCED_TYPE = 'TRIGGER'");
    expect(objectDependencyTarget(details, "dameng", trigger)).toBeUndefined();
    expect(objectDependencyTarget(triggerDetails, "dameng")).toBeUndefined();
    expect(objectDependencyTarget(triggerDetails, "oracle", trigger)).toBeUndefined();
    expect(objectDependencyTarget({ ...triggerDetails, schema: "different" }, "dameng", trigger)).toBeUndefined();
    trigger.oracle_metadata!.engineVersion = "6.0";
    expect(objectDependencyTarget(triggerDetails, "dameng", trigger)).toBeUndefined();
  });

  it("keeps captured identity and reuses the provider SQL without changing quoting or package scope", () => {
    const target = objectDependencyTarget(details, "oceanbase-oracle")!;
    expect(target).toEqual({ connectionId: "original", database: "ORCL", schema: "Mixed.Schema", name: "Mixed.P", objectType: "PROCEDURE" });
    expect(objectDependencySql(target)).toBe(oracleObjectDependenciesSql({ schema: details.schema, objectName: details.name, objectType: "PROCEDURE" }));
    expect(objectDependencyTarget({ ...details, objectType: "PACKAGE_BODY" }, "oracle")?.objectType).toBe("PACKAGE");
    expect(objectDependencyTarget(details, "xugu")).toBeUndefined();
    expect(objectDependencyTarget({ ...details, objectType: "TYPE" }, "oracle")?.objectType).toBe("TYPE");
    expect(objectDependencyTarget({ ...details, objectType: "TABLE" }, "oracle")?.objectType).toBe("TABLE");
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

  it("groups foreign keys by owner and direction and pairs columns by position rather than row order", () => {
    const result: QueryResult = {
      columns: ["DIRECTION", "CONSTRAINT_OWNER", "CONSTRAINT_NAME", "CHILD_OWNER", "CHILD_NAME", "CHILD_COLUMN", "POSITION", "PARENT_OWNER", "PARENT_NAME", "PARENT_COLUMN", "COLUMN_COUNT"],
      rows: [
        ["REFERENCES", "Child.Owner", "Same.FK", "Child.Owner", "Child.Table", "C Two", 2, "Parent.Owner", "Parent.Table", "P Two", 2],
        ["REFERENCES", "Child.Owner", "Same.FK", "Child.Owner", "Child.Table", "C One", 1, "Parent.Owner", "Parent.Table", "P One", 2],
        ["REFERENCED_BY", "Child.Owner", "Same.FK", "Child.Owner", "Child.Table", "C One", 1, "Parent.Owner", "Parent.Table", "P One", 2],
        ["REFERENCES", "Hidden", "Same.FK", "Hidden", "T", "C", 1, null, null, null, 1],
      ],
      affected_rows: 0,
      execution_time_ms: 1,
    };
    const rows = objectForeignKeyRows(result);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      direction: "REFERENCES",
      complete: true,
      parent: { schema: "Parent.Owner", name: "Parent.Table" },
      columns: [
        { position: 1, child: "C One", parent: "P One" },
        { position: 2, child: "C Two", parent: "P Two" },
      ],
    });
    expect(rows[1]?.complete).toBe(false);
    expect(rows[2]?.complete).toBe(false);
    expect(relationObjectNavigation(rows[2]!.parent)).toBeUndefined();
  });

  it("retains both owners and rejects schema triggers as fabricated table parents", () => {
    const rows = objectOwnershipRows({
      columns: ["CHILD_OWNER", "CHILD_NAME", "CHILD_TYPE", "PARENT_OWNER", "PARENT_NAME", "PARENT_TYPE"],
      rows: [
        ["Other", "Idx.Dot", "INDEX", "Parent", "Table.Dot", "TABLE"],
        ["Other", "Tr", "TRIGGER", null, null, "SCHEMA"],
      ],
      affected_rows: 0,
      execution_time_ms: 1,
    });
    expect(rows[0]?.child).toEqual({ schema: "Other", name: "Idx.Dot", type: "INDEX" });
    expect(relationObjectNavigation(rows[0]!.parent)).toMatchObject({ schema: "Parent", name: "Table.Dot", type: "table", nameQuoted: true });
    expect(relationObjectNavigation(rows[1]!.parent)).toBeUndefined();
    expect(objectDependencySql({ ...details, objectType: "TABLE" }, "foreignKeys")).toContain("ALL_CONSTRAINTS");
    expect(() => objectDependencySql({ ...details, objectType: "PROCEDURE" }, "foreignKeys")).toThrow("not supported");
  });
});
