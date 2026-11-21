import { describe, expect, it } from "vitest";
import { queryContextObjectActions, resolveQueryContextObjectTarget } from "@/lib/sql/queryCursorTableTarget";
import type { SqlCompletionTable } from "@/lib/sql/sqlCompletion";
import type { SqlObjectNavigationType } from "@/lib/sql/sqlNavigation";

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
