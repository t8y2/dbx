import { strict as assert } from "node:assert";
import { test } from "vitest";
import { insertSidebarTableSearchControls } from "../../apps/desktop/src/lib/sidebar/sidebarTableSearchControl.ts";
import type { FlatTreeNode } from "../../apps/desktop/src/composables/useFlatTree.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";

function flat(node: TreeNode, depth = 0): FlatTreeNode {
  return {
    node,
    depth,
    id: node.id,
    type: node.type,
    poolType: node.type,
  };
}

test("inserts a local table search control above simple table children", () => {
  const database: TreeNode = {
    id: "conn:app",
    label: "app",
    type: "database",
    connectionId: "conn",
    database: "app",
    isExpanded: true,
    children: [{ id: "conn:app:orders", label: "orders", type: "table", connectionId: "conn", database: "app" }],
  };
  const table = database.children![0];

  const nodes = insertSidebarTableSearchControls([flat(database), flat(table, 1)], {
    enabled: true,
    sidebarObjectDisplay: "simple",
    activeQueries: {},
  });

  assert.deepEqual(
    nodes.map((item) => item.node.type),
    ["database", "table-search-control", "table"],
  );
  assert.equal(nodes[1].node.tableSearchParentId, "conn:app");
  assert.equal(nodes[1].depth, 1);
});

test("keeps a simple local table search control visible when the current search has no results", () => {
  const database: TreeNode = {
    id: "conn:app",
    label: "app",
    type: "database",
    connectionId: "conn",
    database: "app",
    isExpanded: true,
    children: [],
  };

  const nodes = insertSidebarTableSearchControls([flat(database)], {
    enabled: true,
    sidebarObjectDisplay: "simple",
    activeQueries: { "conn:app": "invoice" },
  });

  assert.deepEqual(
    nodes.map((item) => item.node.type),
    ["database", "table-search-control"],
  );
});

test("inserts a grouped local table search control only for expanded table groups", () => {
  const tableGroup: TreeNode = {
    id: "conn:app:__tables",
    label: "tree.tables",
    type: "group-tables",
    connectionId: "conn",
    database: "app",
    isExpanded: true,
    children: [],
  };
  const viewGroup: TreeNode = {
    id: "conn:app:__views",
    label: "tree.views",
    type: "group-views",
    connectionId: "conn",
    database: "app",
    isExpanded: true,
    children: [],
  };

  const nodes = insertSidebarTableSearchControls([flat(tableGroup, 1), flat(viewGroup, 1)], {
    enabled: true,
    sidebarObjectDisplay: "grouped",
    activeQueries: {},
  });

  assert.deepEqual(
    nodes.map((item) => item.node.type),
    ["group-tables", "table-search-control", "group-views"],
  );
  assert.equal(nodes[1].node.tableSearchParentId, "conn:app:__tables");
});

test("uses isolated virtual scroller pools for each local table search input", () => {
  const first: TreeNode = {
    id: "conn:first:__tables",
    label: "tree.tables",
    type: "group-tables",
    connectionId: "conn",
    database: "first",
    isExpanded: true,
    children: [],
  };
  const second: TreeNode = {
    id: "conn:second:__tables",
    label: "tree.tables",
    type: "group-tables",
    connectionId: "conn",
    database: "second",
    isExpanded: true,
    children: [],
  };

  const nodes = insertSidebarTableSearchControls([flat(first, 1), flat(second, 1)], {
    enabled: true,
    sidebarObjectDisplay: "grouped",
    activeQueries: {},
  });

  const pools = nodes.filter((item) => item.node.type === "table-search-control").map((item) => item.poolType);
  assert.equal(pools.length, 2);
  assert.equal(new Set(pools).size, 2);
});

test("hides local table search controls while global sidebar filtering is active", () => {
  const database: TreeNode = {
    id: "conn:app",
    label: "app",
    type: "database",
    connectionId: "conn",
    database: "app",
    isExpanded: true,
    children: [{ id: "conn:app:orders", label: "orders", type: "table", connectionId: "conn", database: "app" }],
  };

  const nodes = insertSidebarTableSearchControls([flat(database)], {
    enabled: false,
    sidebarObjectDisplay: "simple",
    activeQueries: { "conn:app": "orders" },
  });

  assert.deepEqual(nodes.map((item) => item.node.type), ["database"]);
});
