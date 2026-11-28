import { describe, expect, it } from "vitest";
import { normalizeLocateCandidate, queryContextObjectActions, resolveQueryContextObjectTarget } from "@/lib/sql/queryCursorTableTarget";
import type { SqlCompletionTable } from "@/lib/sql/sqlCompletion";
import type { SqlObjectNavigationType } from "@/lib/sql/sqlNavigation";
import type { TreeNode } from "@/types/database";

function candidate(overrides: Partial<{ schema: string }> = {}) {
  return { connectionId: "conn-1", database: "APP", tableName: "ORDERS", ...overrides };
}

function table(name: string, schema: string | undefined, type: SqlObjectNavigationType): SqlCompletionTable {
  return { name, schema, type };
}

describe("resolveQueryContextObjectTarget", () => {
  it("prefers the query tab schema over a same-named table in another schema", () => {
    // #12865: without a schema in the SQL, the first cache entry used to win and
    // a view in the current schema could be resolved as a table elsewhere.
    const target = resolveQueryContextObjectTarget(candidate(), [table("ORDERS", "OTHER", "table"), table("ORDERS", "APP", "view")], "APP");

    expect(target.type).toBe("view");
    expect(target.schema).toBe("APP");
  });

  it("keeps the first match when no preferred schema is available", () => {
    const target = resolveQueryContextObjectTarget(candidate(), [table("ORDERS", "OTHER", "table"), table("ORDERS", "APP", "view")]);

    expect(target.type).toBe("table");
    expect(target.schema).toBe("OTHER");
  });

  it("keeps an explicit schema in the SQL above the preferred schema", () => {
    const target = resolveQueryContextObjectTarget(candidate({ schema: "OTHER" }), [table("ORDERS", "APP", "view"), table("ORDERS", "OTHER", "table")], "APP");

    expect(target.type).toBe("table");
    expect(target.schema).toBe("OTHER");
  });

  it("falls back to a schema-less match and then the first match", () => {
    const schemaLess = resolveQueryContextObjectTarget(candidate(), [table("ORDERS", "OTHER", "table"), table("ORDERS", undefined, "view")], "APP");
    expect(schemaLess.type).toBe("view");
    expect(schemaLess.schema).toBeUndefined();

    const first = resolveQueryContextObjectTarget(candidate(), [table("ORDERS", "OTHER", "table")], "APP");
    expect(first.type).toBe("table");
    expect(first.schema).toBe("OTHER");
  });

  it("exposes view actions for a view target", () => {
    expect(queryContextObjectActions("view")).toEqual(expect.arrayContaining(["edit-view", "view-source", "view-ddl"]));
    expect(queryContextObjectActions("table")).not.toContain("edit-view");
  });
});

describe("normalizeLocateCandidate for editor context lookup", () => {
  const oracleConnection = { db_type: "oracle", username: "APP" } as const;
  const viewNode: TreeNode = { id: "conn-1:APP:__views:APP:MY_VIEW", label: "MY_VIEW", type: "view", connectionId: "conn-1", database: "APP", schema: "APP" };

  it("aligns an Oracle service-name database with the schema-keyed caches so a view resolves as a view", () => {
    // #15752: the tab database is the service name (ORCL) while the tree and
    // completion index key Oracle objects by schema (APP), so the unaligned
    // lookup missed and the context menu fell back to table-structure actions.
    const normalized = normalizeLocateCandidate({ connectionId: "conn-1", database: "ORCL", tableName: "MY_VIEW" }, [viewNode], oracleConnection);

    expect(normalized).toMatchObject({ database: "APP", schema: "APP" });
    const target = resolveQueryContextObjectTarget(normalized, [table("MY_VIEW", "APP", "view")]);
    expect(target.type).toBe("view");
    expect(queryContextObjectActions(target.type)).toContain("edit-view");
    expect(queryContextObjectActions(target.type)).not.toContain("edit-table-structure");
  });

  it("aligns a schema-qualified Oracle candidate even before the tree loads", () => {
    const normalized = normalizeLocateCandidate({ connectionId: "conn-1", database: "ORCL", schema: "APP", tableName: "MY_VIEW" }, [], oracleConnection);

    expect(normalized).toMatchObject({ database: "APP", schema: "APP" });
  });

  it("leaves non-root-schema candidates unchanged", () => {
    const mysqlCandidate = { connectionId: "conn-1", database: "shop", tableName: "orders" };

    expect(normalizeLocateCandidate(mysqlCandidate, [viewNode], { db_type: "mysql", username: "root" })).toEqual(mysqlCandidate);
  });
});
