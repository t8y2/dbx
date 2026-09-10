import { describe, expect, it } from "vitest";
import { objectBrowserTablesToAiTreeNodes } from "@/lib/ai/objectBrowserToAiTargets";

function tab(overrides: Partial<Parameters<typeof objectBrowserTablesToAiTreeNodes>[0]> = {}) {
  return {
    id: "tab-1",
    connectionId: "conn-1",
    database: "db-1",
    schema: undefined,
    catalog: undefined,
    ...overrides,
  } as any;
}

describe("objectBrowserTablesToAiTreeNodes", () => {
  it("maps table names and row-level schemas into AI tree nodes", () => {
    const nodes = objectBrowserTablesToAiTreeNodes(tab(), [
      { name: "users", schema: "public" },
      { name: "orders", schema: "sales" },
    ]);

    expect(nodes).toEqual([
      {
        id: "conn-1:db-1:public:users",
        label: "users",
        type: "table",
        connectionId: "conn-1",
        database: "db-1",
        catalog: undefined,
        schema: "public",
      },
      {
        id: "conn-1:db-1:sales:orders",
        label: "orders",
        type: "table",
        connectionId: "conn-1",
        database: "db-1",
        catalog: undefined,
        schema: "sales",
      },
    ]);
  });

  it("falls back to the tab schema when a row has no schema", () => {
    const nodes = objectBrowserTablesToAiTreeNodes(tab({ schema: "app" }), [{ name: "users" }]);

    expect(nodes[0].schema).toBe("app");
    expect(nodes[0].id).toBe("conn-1:db-1:app:users");
  });

  it("falls back to the database name as a last resort", () => {
    const nodes = objectBrowserTablesToAiTreeNodes(tab(), [{ name: "users" }]);

    expect(nodes[0].schema).toBe("db-1");
    expect(nodes[0].id).toBe("conn-1:db-1:db-1:users");
  });

  it("carries the tab catalog through for external-catalog contexts (Doris/StarRocks)", () => {
    const nodes = objectBrowserTablesToAiTreeNodes(tab({ catalog: "hive_catalog" }), [{ name: "orders", schema: "tpch" }]);

    expect(nodes[0]).toEqual({
      id: "conn-1:db-1:tpch:orders",
      label: "orders",
      type: "table",
      connectionId: "conn-1",
      database: "db-1",
      catalog: "hive_catalog",
      schema: "tpch",
    });
  });
});
