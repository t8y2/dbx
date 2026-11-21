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
import { computed, reactive, ref } from "vue";
import { flattenTree } from "../../apps/desktop/src/composables/useFlatTree.ts";
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

describe("sidebar local table search no-op projection (#12280)", () => {
  const inactiveCases: Array<{ name: string; enabled: boolean; queries: Record<string, string> }> = [
    { name: "disabled with a retained query", enabled: false, queries: { "conn:db": "order" } },
    { name: "enabled with no queries", enabled: true, queries: {} },
    { name: "enabled with only blank queries", enabled: true, queries: { "conn:db": " \t\n", other: "" } },
  ];

  for (const { name, enabled, queries } of inactiveCases) {
    it(`preserves the input array and node identities when ${name}`, () => {
      const children = liveChildren();
      const parent = schemaNode(children);
      const nodes = [parent];
      const result = filterLocallySearchedTables(nodes, { enabled, queries, indexedResults: {} });
      expect(result).toBe(nodes);
      expect(result[0]).toBe(parent);
      expect(result[0].children).toBe(children);
    });

    it(`does not read descendants when ${name}`, () => {
      const parent = schemaNode([]);
      let childrenReads = 0;
      Object.defineProperty(parent, "children", {
        get() {
          childrenReads++;
          return [];
        },
      });
      filterLocallySearchedTables([parent], { enabled, queries, indexedResults: {} });
      expect(childrenReads).toBe(0);
    });
  }

  it("scans the query map only once for an active nested search", () => {
    let scans = 0;
    const queries = new Proxy(
      { "conn:db": "order" },
      {
        ownKeys(target) {
          scans++;
          return Reflect.ownKeys(target);
        },
      },
    );
    const nodes: TreeNode[] = [{ id: "conn", label: "Connection", type: "connection", children: [schemaNode(liveChildren())] }];
    const result = filterLocallySearchedTables(nodes, { enabled: true, queries, indexedResults: {} });
    expect(result[0].children![0].children!.map((node) => node.label)).toEqual(["t_order"]);
    expect(scans).toBe(1);
  });

  it.each(["missing", "null", "indexed"] as const)("keeps nested camelCase searches and live node state with %s results", (mode) => {
    const entries: TableInfo[] = [
      { name: "OrderLine", table_type: "TABLE", comment: null },
      { name: "customer", table_type: "TABLE", comment: null },
    ];
    const children: TreeNode[] = entries.map((entry) => ({ id: `conn:db:${entry.name}`, label: entry.name, type: "table", connectionId: "conn", database: "db" }));
    children[0].isExpanded = true;
    children[0].children = [{ id: "columns", label: "Columns", type: "group-columns" }];
    const parent = schemaNode(children);
    const nodes: TreeNode[] = [{ id: "conn", label: "Connection", type: "connection", children: [parent] }];
    const indexedResults = mode === "missing" ? {} : { [parent.id]: mode === "null" ? null : entries };
    const result = filterLocallySearchedTables(nodes, { enabled: true, queries: { [parent.id]: "OL" }, indexedResults });
    const matched = result[0].children![0].children!;
    expect(matched.map((node) => node.label)).toEqual(["OrderLine"]);
    expect(matched[0].isExpanded).toBe(true);
    expect(matched[0].children).toEqual(children[0].children);
    expect(matched[0].children![0]).toBe(children[0].children[0]);
    expect(nodes[0].children![0]).toBe(parent);
    expect(parent.children).toBe(children);
    expect(children).toHaveLength(2);
  });

  it("keeps downstream flattening reactive with the same root array", () => {
    const nodes = reactive<TreeNode[]>([{ ...schemaNode(liveChildren()), isExpanded: true }]);
    const projected = computed(() => filterLocallySearchedTables(nodes, { enabled: true, queries: {}, indexedResults: {} }));
    const labels = computed(() => flattenTree(projected.value).map(({ node }) => node.label));
    expect(projected.value).toBe(nodes);
    expect(labels.value).toEqual(["db", "t_order", "t_customer"]);
    nodes[0].children = [{ id: "replacement", label: "replacement", type: "table" }];
    expect(labels.value).toEqual(["db", "replacement"]);
    nodes[0].isExpanded = false;
    expect(labels.value).toEqual(["db"]);
    nodes[0].isExpanded = true;
    nodes[0].children.push({ id: "appended", label: "appended", type: "table" });
    expect(labels.value).toEqual(["db", "replacement", "appended"]);
    expect(projected.value).toBe(nodes);
  });

  it("tracks added, cleared and deleted queries and enabling local search", () => {
    const nodes = reactive<TreeNode[]>([schemaNode(liveChildren())]);
    const queries = reactive<Record<string, string>>({});
    const enabled = ref(true);
    const projected = computed(() => filterLocallySearchedTables(nodes, { enabled: enabled.value, queries, indexedResults: {} }));
    const labels = computed(() => projected.value[0].children!.map((node) => node.label));
    expect(labels.value).toEqual(["t_order", "t_customer"]);
    queries["conn:db"] = "订单";
    expect(labels.value).toEqual(["t_order"]);
    queries["conn:db"] = " ";
    expect(labels.value).toEqual(["t_order", "t_customer"]);
    queries["conn:db"] = "customer";
    expect(labels.value).toEqual(["t_customer"]);
    delete queries["conn:db"];
    expect(labels.value).toEqual(["t_order", "t_customer"]);
    enabled.value = false;
    queries["conn:db"] = "订单";
    expect(labels.value).toEqual(["t_order", "t_customer"]);
    enabled.value = true;
    expect(labels.value).toEqual(["t_order"]);
  });
});
