// Regression test for t8y2/dbx #9094.
//
// Local-mode sidebar table search only matched table names, even though the
// persisted search index, the global sidebar search, and the backend's
// metadata filter all treat the table comment as searchable text. A user
// searching "订单" against a database whose tables are all pinyin/English
// names with Chinese comments found nothing. filterLocallySearchedTables must
// match name OR comment across all three branches: the indexed branch, the
// indexed === null fallback (index not built yet), and the no-index branch.
import { describe, expect, it } from "vitest";
import { filterLocallySearchedTables } from "../../apps/desktop/src/lib/sidebar/sidebarSearchTree.ts";
import type { TableInfo, TreeNode } from "@/types/database";

const tables: TableInfo[] = [
  { name: "t_order", table_type: "TABLE", comment: "订单主表" },
  { name: "t_customer", table_type: "TABLE", comment: null },
];

function schemaNode(children: TreeNode[]): TreeNode {
  return { id: "conn:db", label: "db", type: "schema", connectionId: "conn", database: "db", children };
}

function liveChildren(): TreeNode[] {
  return tables.map((table) => ({
    id: `conn:db:${table.name}`,
    label: table.name,
    type: "table" as const,
    connectionId: "conn",
    database: "db",
    comment: table.comment ?? undefined,
  }));
}

function project(nodes: TreeNode[], indexed: Record<string, TableInfo[] | null>) {
  return filterLocallySearchedTables(nodes, { enabled: true, queries: { "conn:db": "订单" }, indexedResults: indexed })[0].children!;
}

describe("sidebar local table search matches table comments (#9094)", () => {
  it("matches by comment on the indexed branch", () => {
    const children = project([schemaNode(liveChildren())], { "conn:db": tables });
    expect(children.map((node) => node.label)).toEqual(["t_order"]);
  });

  it("matches by comment on the indexed === null fallback branch", () => {
    const children = project([schemaNode(liveChildren())], { "conn:db": null });
    expect(children.map((node) => node.label)).toEqual(["t_order"]);
  });

  it("matches by comment on the no-index branch", () => {
    const children = project([schemaNode(liveChildren())], {});
    expect(children.map((node) => node.label)).toEqual(["t_order"]);
  });

  it("still matches by name and keeps name-only tables for name queries", () => {
    for (const indexed of [{ "conn:db": tables }, { "conn:db": null }, {}]) {
      const children = filterLocallySearchedTables([schemaNode(liveChildren())], { enabled: true, queries: { "conn:db": "customer" }, indexedResults: indexed })[0].children!;
      expect(children.map((node) => node.label)).toEqual(["t_customer"]);
    }
  });
});
