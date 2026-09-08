import { bench, describe } from "vitest";

import { filterSidebarTree } from "@/lib/sidebar/sidebarSearchTree";
import { buildTableTreeNodes } from "@/lib/table/tableTree";
import type { TableInfo, TreeNode } from "@/types/database";

const CONNECTION_ID = "benchmark-connection";
const DATABASE = "benchmark";
const SCHEMA = "public";
const EMPTY_COLLAPSED_IDS = new Set<string>();
const TABLE_COUNTS = [1_000, 10_000] as const;

function tableName(index: number): string {
  return `customer_orders_${index.toString().padStart(5, "0")}`;
}

function generateTables(count: number): TableInfo[] {
  return Array.from({ length: count }, (_, index) => ({
    name: tableName(index),
    table_type: "BASE TABLE",
    comment: index % 10 === 0 ? `benchmark table ${index}` : null,
    parent_schema: null,
    parent_name: null,
  }));
}

function buildSearchTree(tableNodes: TreeNode[]): TreeNode[] {
  return [
    {
      id: CONNECTION_ID,
      label: "Benchmark",
      type: "connection",
      connectionId: CONNECTION_ID,
      isExpanded: true,
      children: [
        {
          id: `${CONNECTION_ID}:${SCHEMA}`,
          label: SCHEMA,
          type: "schema",
          connectionId: CONNECTION_ID,
          database: DATABASE,
          schema: SCHEMA,
          isExpanded: true,
          children: [
            {
              id: `${CONNECTION_ID}:${SCHEMA}:__tables`,
              label: "Tables",
              type: "group-tables",
              connectionId: CONNECTION_ID,
              database: DATABASE,
              schema: SCHEMA,
              isExpanded: true,
              children: tableNodes,
            },
          ],
        },
      ],
    },
  ];
}

for (const tableCount of TABLE_COUNTS) {
  const tables = generateTables(tableCount);
  const tableNodes = buildTableTreeNodes({
    nodeId: `${CONNECTION_ID}:${SCHEMA}:__tables`,
    connectionId: CONNECTION_ID,
    database: DATABASE,
    schema: SCHEMA,
    tables,
  });
  const searchTree = buildSearchTree(tableNodes);
  const tailQuery = tableName(tableCount - 1);

  describe(`large sidebar schema: ${tableCount.toLocaleString()} tables`, () => {
    bench("build table tree nodes", () => {
      const nodes = buildTableTreeNodes({
        nodeId: `${CONNECTION_ID}:${SCHEMA}:__tables`,
        connectionId: CONNECTION_ID,
        database: DATABASE,
        schema: SCHEMA,
        tables,
      });
      if (nodes.length !== tableCount) throw new Error(`expected ${tableCount} table nodes`);
    });

    bench("filter sidebar tree for a tail table", () => {
      const filtered = filterSidebarTree(searchTree, tailQuery, EMPTY_COLLAPSED_IDS);
      if (filtered.length === 0) throw new Error("expected the tail table query to match");
    });
  });
}
