import { describe, expect, it } from "vitest";
import { createFlatTreeIndex, flattenTree } from "@/composables/useFlatTree";
import { resolvePlainStickyContainerIndex, resolveSidebarStickyProductionNode } from "@/lib/sidebar/sidebarStickyProductionContext";
import { productionContextForDatabase } from "@/lib/database/productionSafety";
import type { ConnectionConfig, TreeNode, TreeNodeType } from "@/types/database";

function node(id: string, type: TreeNodeType, children: TreeNode[] = []): TreeNode {
  return { id, label: id, type, connectionId: "connection", database: id, isExpanded: true, children };
}

function fixture(roots: TreeNode[]) {
  const nodes = flattenTree(roots);
  const index = createFlatTreeIndex(nodes, {
    isSelectable: () => true,
    isBoundary: (type) => type === "connection" || type === "connection-group",
    isDatabaseContainer: (type) => type === "database",
    isSchemaContainer: (type) => type === "schema",
  });
  return { nodes, index, resolve: (current: number, scroll: number, height = 28) => resolveSidebarStickyProductionNode(nodes, index, current, scroll, height)?.id ?? null };
}

const production: ConnectionConfig = { id: "connection", name: "Reporting", db_type: "postgres", host: "localhost", port: 5432, username: "", password: "", production_databases: ["production"] };

describe("sidebar sticky production context", () => {
  it("uses real plain-row positions instead of switching by the estimated row height", () => {
    const scope = fixture([node("connection", "connection", [node("first", "database", [node("query", "saved-sql-root")]), node("second", "database")])]);
    const rows = scope.nodes.map((item, index) => ({ nodeId: item.id, top: 100 + index * 29 }));
    const firstTop = scope.nodes.findIndex((item) => item.id === "first");
    const secondTop = scope.nodes.findIndex((item) => item.id === "second");
    expect(
      resolvePlainStickyContainerIndex(
        scope.nodes,
        scope.index,
        rows.map((row) => ({ ...row, top: row.top - 29 })),
        100,
      ),
    ).toBe(firstTop);
    expect(resolvePlainStickyContainerIndex(scope.nodes, scope.index, rows, 100)).toBe(-1);
    expect(secondTop).toBeGreaterThan(firstTop);
  });

  it("has no marker before a container becomes fixed", () => {
    expect(fixture([node("connection", "connection")]).resolve(-1, 0)).toBeNull();
  });

  it.each(["database", "schema"] as const)("transfers the fixed %s context as the next row begins to cover it", (type) => {
    const scope = fixture([node("connection", "connection", [node("production", type, [node("table", "table")]), node("staging", type)])]);
    expect(scope.resolve(1, 55)).toBe("production");
    expect(scope.resolve(1, 57)).toBe("staging");
    expect(scope.resolve(3, 85)).toBe("staging");
    const incoming = resolveSidebarStickyProductionNode(scope.nodes, scope.index, 1, 57, 28);
    expect(productionContextForDatabase(production, incoming?.node.database).active).toBe(false);
  });

  it("does not let a production marker cross a connection boundary", () => {
    const scope = fixture([node("prod-connection", "connection", [node("production", "database", [node("table", "table")])]), node("other-connection", "connection", [node("other", "database")])]);
    expect(scope.resolve(1, 55)).toBe("production");
    expect(scope.resolve(1, 57)).toBeNull();
    expect(scope.resolve(-1, 85)).toBeNull();
    expect(scope.resolve(4, 113)).toBe("other");
  });

  it("ends the old context at a group boundary before the next connection", () => {
    const scope = fixture([node("connection", "connection", [node("production", "database", [node("table", "table")])]), node("group", "connection-group", [node("next-connection", "connection", [node("other", "database")])])]);
    expect(scope.resolve(1, 57)).toBeNull();
  });

  it("uses compact row height for the same handover", () => {
    const scope = fixture([node("connection", "connection", [node("production", "database", [node("table", "table")]), node("staging", "database")])]);
    expect(scope.resolve(1, 47, 24)).toBe("production");
    expect(scope.resolve(1, 49, 24)).toBe("staging");
  });

  it("retains production through a production-to-production handover", () => {
    const scope = fixture([node("connection", "connection", [node("production", "database", [node("table", "table")]), node("second-production", "database")])]);
    const connection = { ...production, production_databases: ["production", "second-production"] };
    for (const scroll of [55, 57, 83, 85]) {
      const incoming = resolveSidebarStickyProductionNode(scope.nodes, scope.index, scroll < 84 ? 1 : 3, scroll, 28);
      expect(productionContextForDatabase(connection, incoming?.node.database).active).toBe(true);
    }
  });
});
