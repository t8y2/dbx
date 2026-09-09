import { describe, expect, it } from "vitest";
import { xuguDependencyObjectTypeForTreeNode, xuguObjectDependenciesSql } from "@/lib/database/xuguObjectDependencies";

describe("xuguObjectDependenciesSql", () => {
  it("reads both directions from the accessible dependency dictionary", () => {
    const sql = xuguObjectDependenciesSql({ schema: "APP", objectName: "ORDERS", objectType: "table" });

    expect(sql).toContain("JOIN ALL_DEPENDS");
    expect(sql).toContain("WHERE o.DB_ID = CURRENT_DB_ID");
    expect(sql).toContain("'DEPENDS_ON'");
    expect(sql).toContain("'REFERENCED_BY'");
    expect(sql).toContain("AND o.OBJ_TYPE = 5");
    expect(sql).toContain("d.OWNER_ID2 = t.SCHEMA_ID AND d.OBJ_ID2 = t.OBJ_ID AND d.OBJ_TYPE2 = t.OBJ_TYPE");
    expect(sql).toContain("SELECT 'DEPENDS_ON' AS DIRECTION, d.OWNER_ID1 AS OWNER_ID, d.OBJ_ID1 AS OBJ_ID, d.OBJ_TYPE1 AS OBJ_TYPE");
    expect(sql).toContain("d.OWNER_ID1 = t.SCHEMA_ID AND d.OBJ_ID1 = t.OBJ_ID AND d.OBJ_TYPE1 = t.OBJ_TYPE");
    expect(sql).toContain("SELECT 'REFERENCED_BY' AS DIRECTION, d.OWNER_ID2 AS OWNER_ID, d.OBJ_ID2 AS OBJ_ID, d.OBJ_TYPE2 AS OBJ_TYPE");
    expect(sql).toContain("o.SCHEMA_ID = r.OWNER_ID AND o.OBJ_ID = r.OBJ_ID AND o.OBJ_TYPE = r.OBJ_TYPE");
    expect(sql).not.toContain("t.USER_ID");
    expect(sql).not.toContain("o.USER_ID = r.OWNER_ID");
    expect(sql).toContain("ORDER BY r.DIRECTION, s.SCHEMA_NAME, o.OBJ_NAME");
  });

  it("uses the Xugu routine object type and escapes dictionary lookup literals", () => {
    const sql = xuguObjectDependenciesSql({ schema: "O'REILLY", objectName: "RUN'JOB", objectType: "function" });

    expect(sql).toContain("UPPER('O''REILLY')");
    expect(sql).toContain("UPPER('RUN''JOB')");
    expect(sql).toContain("AND o.OBJ_TYPE = 7");
  });
});

describe("xuguDependencyObjectTypeForTreeNode", () => {
  it.each([
    ["table", "table"],
    ["view", "view"],
    ["procedure", "procedure"],
    ["function", "function"],
    ["trigger", "trigger"],
    ["package", "package"],
  ] as const)("maps %s to a supported dependency object", (nodeType, expected) => {
    expect(xuguDependencyObjectTypeForTreeNode(nodeType)).toBe(expected);
  });

  it.each(["materialized_view", "package-body", "type", "sequence", "synonym"] as const)("does not expose unsupported %s objects", (nodeType) => {
    expect(xuguDependencyObjectTypeForTreeNode(nodeType)).toBeNull();
  });
});
