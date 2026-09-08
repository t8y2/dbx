import { bench, describe } from "vitest";

import { filterSidebarTree } from "@/lib/sidebar/sidebarSearchTree";
import { buildTableTreeNodes } from "@/lib/table/tableTree";
import type { TableInfo, TreeNode } from "@/types/database";

const CONNECTION_ID = "benchmark-connection";
const DATABASE = "benchmark";
const SCHEMA = "public";
const EMPTY_COLLAPSED_IDS = new Set<string>();
const TABLE_COUNTS = [1_000, 10_000, 50_000] as const;
const STRUCTURE_TABLE_COUNT = 10_000;

function tableName(index: number): string {
  return `customer_orders_${index.toString().padStart(5, "0")}`;
}

function generateTables(count: number, resolveName: (index: number) => string = tableName): TableInfo[] {
  return Array.from({ length: count }, (_, index) => ({
    name: resolveName(index),
    table_type: "BASE TABLE",
    comment: index % 10 === 0 ? `benchmark table ${index}` : null,
    parent_schema: null,
    parent_name: null,
  }));
}

function buildTableNodes(tables: TableInfo[], schema = SCHEMA, nodeId = `${CONNECTION_ID}:${schema}:__tables`): TreeNode[] {
  return buildTableTreeNodes({
    nodeId,
    connectionId: CONNECTION_ID,
    database: DATABASE,
    schema,
    tables,
  });
}

function tableGroup(schema: string, tableNodes: TreeNode[]): TreeNode {
  return {
    id: `${CONNECTION_ID}:${schema}:__tables`,
    label: "Tables",
    type: "group-tables",
    connectionId: CONNECTION_ID,
    database: DATABASE,
    schema,
    isExpanded: true,
    children: tableNodes,
  };
}

function buildSearchTree(tableNodes: TreeNode[]): TreeNode[] {
  return buildMultiSchemaSearchTree([{ schema: SCHEMA, tableNodes }]);
}

function buildMultiSchemaSearchTree(schemas: Array<{ schema: string; tableNodes: TreeNode[] }>): TreeNode[] {
  return [
    {
      id: CONNECTION_ID,
      label: "Benchmark",
      type: "connection",
      connectionId: CONNECTION_ID,
      isExpanded: true,
      children: schemas.map(({ schema, tableNodes }) => ({
        id: `${CONNECTION_ID}:${schema}`,
        label: schema,
        type: "schema" as const,
        connectionId: CONNECTION_ID,
        database: DATABASE,
        schema,
        isExpanded: true,
        children: [tableGroup(schema, tableNodes)],
      })),
    },
  ];
}

function visibleTableCount(filtered: TreeNode[]): number {
  const connection = filtered[0];
  if (!connection) return 0;
  return (connection.children ?? []).reduce((count, schema) => count + (schema.children?.[0]?.children?.length ?? 0), 0);
}

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const shuffled = [...items];
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

for (const tableCount of TABLE_COUNTS) {
  const tables = generateTables(tableCount);
  const tableNodes = buildTableNodes(tables);
  const searchTree = buildSearchTree(tableNodes);
  const queries = [
    { name: "no match", query: "missing_table", expectedMatches: 0 },
    { name: "all tables", query: "customer", expectedMatches: tableCount },
    { name: "first table", query: tableName(0), expectedMatches: 1 },
    { name: "middle table", query: tableName(Math.floor(tableCount / 2)), expectedMatches: 1 },
    { name: "last table", query: tableName(tableCount - 1), expectedMatches: 1 },
    { name: "table comment", query: `benchmark table ${tableCount - 10}`, expectedMatches: 1 },
  ] as const;

  describe(`large sidebar schema: ${tableCount.toLocaleString()} tables`, () => {
    bench("build table tree nodes", () => {
      const nodes = buildTableNodes(tables);
      if (nodes.length !== tableCount) throw new Error(`expected ${tableCount} table nodes`);
    });

    for (const { name, query, expectedMatches } of queries) {
      bench(`filter sidebar tree: ${name}`, () => {
        const filtered = filterSidebarTree(searchTree, query, EMPTY_COLLAPSED_IDS);
        const matches = visibleTableCount(filtered);
        if (matches !== expectedMatches) throw new Error(`expected ${expectedMatches} table matches, received ${matches}`);
      });
    }
  });
}

describe(`large sidebar schema data shapes: ${STRUCTURE_TABLE_COUNT.toLocaleString()} tables`, () => {
  const sortedTables = generateTables(STRUCTURE_TABLE_COUNT);
  const reversedTables = [...sortedTables].reverse();
  const shuffledTables = seededShuffle(sortedTables, 0x5eed_1234);

  bench("build table tree nodes from reverse order", () => {
    const nodes = buildTableNodes(reversedTables);
    if (nodes.length !== STRUCTURE_TABLE_COUNT) throw new Error(`expected ${STRUCTURE_TABLE_COUNT} table nodes`);
  });

  bench("build table tree nodes from seeded random order", () => {
    const nodes = buildTableNodes(shuffledTables);
    if (nodes.length !== STRUCTURE_TABLE_COUNT) throw new Error(`expected ${STRUCTURE_TABLE_COUNT} table nodes`);
  });

  for (const nameLength of [128, 255] as const) {
    const suffixLength = nameLength - "long_table_00000_".length;
    const longNameTables = generateTables(STRUCTURE_TABLE_COUNT, (index) => `long_table_${index.toString().padStart(5, "0")}_${"x".repeat(suffixLength)}`);
    const longNameTree = buildSearchTree(buildTableNodes(longNameTables));
    const query = longNameTables[longNameTables.length - 1]?.name ?? "";

    bench(`filter sidebar tree with ${nameLength}-character names`, () => {
      const filtered = filterSidebarTree(longNameTree, query, EMPTY_COLLAPSED_IDS);
      if (visibleTableCount(filtered) !== 1) throw new Error("expected one long-name table match");
    });
  }

  const unicodeTables = generateTables(STRUCTURE_TABLE_COUNT, (index) => `客户订单_日本語_📦_${index.toString().padStart(5, "0")}`);
  const unicodeTree = buildSearchTree(buildTableNodes(unicodeTables));

  bench("filter sidebar tree with Unicode names", () => {
    const filtered = filterSidebarTree(unicodeTree, unicodeTables[unicodeTables.length - 1]?.name ?? "", EMPTY_COLLAPSED_IDS);
    if (visibleTableCount(filtered) !== 1) throw new Error("expected one Unicode table match");
  });

  const partitionTables = generateTables(STRUCTURE_TABLE_COUNT).map((table, index, tables) => {
    if (index % 10 !== 9) return table;
    return { ...table, parent_schema: SCHEMA, parent_name: tables[index - 1].name };
  });

  bench("build table tree nodes with ten percent partitions", () => {
    const nodes = buildTableNodes(partitionTables);
    const expectedRoots = STRUCTURE_TABLE_COUNT - STRUCTURE_TABLE_COUNT / 10;
    if (nodes.length !== expectedRoots) throw new Error(`expected ${expectedRoots} root table nodes`);
  });
});

describe("large sidebar with ten schemas", () => {
  const schemaCount = 10;
  const tablesPerSchema = 1_000;
  const schemas = Array.from({ length: schemaCount }, (_, schemaIndex) => {
    const schema = `schema_${schemaIndex.toString().padStart(2, "0")}`;
    const tables = generateTables(tablesPerSchema, (tableIndex) => `${schema}_${tableName(tableIndex)}`);
    return { schema, tableNodes: buildTableNodes(tables, schema) };
  });
  const searchTree = buildMultiSchemaSearchTree(schemas);
  const tailQuery = `schema_09_${tableName(tablesPerSchema - 1)}`;

  bench("filter across ten schemas for a tail table", () => {
    const filtered = filterSidebarTree(searchTree, tailQuery, EMPTY_COLLAPSED_IDS);
    if (visibleTableCount(filtered) !== 1) throw new Error("expected one cross-schema table match");
  });
});
