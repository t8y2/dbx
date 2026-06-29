import { test } from "vitest";
import assert from "node:assert/strict";
import { buildGroupedObjectTreeNodes, buildObjectGroupPlaceholderNodes, buildSimpleObjectTreeNodes, buildTableTreeNodes, filterSimpleSidebarSupplementalObjects, mergeTableInfosIntoObjects, mergeTableTreePageChildren } from "../../apps/desktop/src/lib/tableTree.ts";
import type { ObjectInfo, TableInfo, TreeNode } from "../../apps/desktop/src/types/database.ts";

function table(name: string, parent?: string): TableInfo {
  return {
    name,
    table_type: "BASE TABLE",
    comment: null,
    parent_schema: parent ? "public" : null,
    parent_name: parent ?? null,
  };
}

function object(name: string, parent?: string): ObjectInfo {
  return {
    name,
    object_type: "TABLE",
    schema: "public",
    comment: null,
    created_at: null,
    updated_at: null,
    parent_schema: parent ? "public" : null,
    parent_name: parent ?? null,
  };
}

function partitionGroup(node: TreeNode): TreeNode | undefined {
  return node.children?.find((child) => child.type === "group-partitions");
}

test("buildTableTreeNodes nests multi-level table partitions", () => {
  const nodes = buildTableTreeNodes({
    nodeId: "conn:app:public",
    connectionId: "conn",
    database: "app",
    schema: "public",
    tables: [table("events"), table("events_2026", "events"), table("events_2026_05", "events_2026"), table("users")],
  });

  assert.deepEqual(
    nodes.map((node) => node.label),
    ["events", "users"],
  );
  assert.equal(nodes[0].id, "conn:app:public:events");

  const events = nodes[0];
  const firstLevel = partitionGroup(events);
  assert.equal(firstLevel?.label, "tree.partitions");
  assert.deepEqual(
    firstLevel?.children?.map((node) => node.label),
    ["events_2026"],
  );

  const secondLevel = partitionGroup(firstLevel!.children![0]);
  assert.deepEqual(
    secondLevel?.children?.map((node) => node.label),
    ["events_2026_05"],
  );
});

test("buildTableTreeNodes keeps partitions visible when their parent is not loaded", () => {
  const nodes = buildTableTreeNodes({
    nodeId: "conn:app:public",
    connectionId: "conn",
    database: "app",
    schema: "public",
    tables: [table("events_2026", "events")],
  });

  assert.deepEqual(
    nodes.map((node) => node.label),
    ["events_2026"],
  );
});

test("mergeTableTreePageChildren attaches later page partitions to loaded parents", () => {
  const firstPage = buildTableTreeNodes({
    nodeId: "conn:app:public",
    connectionId: "conn",
    database: "app",
    schema: "public",
    tables: [table("events"), table("events_region_0", "events")],
  });
  const secondPage = buildTableTreeNodes({
    nodeId: "conn:app:public",
    connectionId: "conn",
    database: "app",
    schema: "public",
    tables: [table("events_region_0_2026_01", "events_region_0")],
  });

  const merged = mergeTableTreePageChildren(firstPage, secondPage, "conn", "app");
  assert.deepEqual(
    merged.map((node) => node.label),
    ["events"],
  );

  const regionPartition = partitionGroup(merged[0])?.children?.[0];
  assert.equal(regionPartition?.label, "events_region_0");
  assert.deepEqual(
    partitionGroup(regionPartition!)?.children?.map((node) => node.label),
    ["events_region_0_2026_01"],
  );
});

test("buildTableTreeNodes keeps sidebar tables in natural name order", () => {
  const nodes = buildTableTreeNodes({
    nodeId: "conn:app:public",
    connectionId: "conn",
    database: "app",
    schema: "public",
    tables: [table("chat_staff"), table("chat_staff_his"), table("staff"), table("staff_his")],
  });

  assert.deepEqual(
    nodes.map((node) => node.label),
    ["chat_staff", "chat_staff_his", "staff", "staff_his"],
  );
});

test("buildTableTreeNodes does not relocate prefixed business tables by suffix", () => {
  const nodes = buildTableTreeNodes({
    nodeId: "conn:app",
    connectionId: "conn",
    database: "app",
    tables: [table("CurrentStock"), table("YonSuite_CurrentStock"), table("YonSuite_LocationStock")],
  });

  assert.deepEqual(
    nodes.map((node) => node.label),
    ["CurrentStock", "YonSuite_CurrentStock", "YonSuite_LocationStock"],
  );
});

test("buildGroupedObjectTreeNodes nests partitions inside the tables group", () => {
  const groups = buildGroupedObjectTreeNodes({
    nodeId: "conn:app:public",
    connectionId: "conn",
    database: "app",
    schema: "public",
    objects: [object("events"), object("events_2026", "events"), object("events_2026_05", "events_2026")],
  });

  const tableGroup = groups.find((node) => node.type === "group-tables");
  assert.equal(tableGroup?.objectCount, 3);
  assert.deepEqual(
    tableGroup?.children?.map((node) => node.label),
    ["events"],
  );
  assert.equal(tableGroup?.children?.[0]?.id, "conn:app:public:__tables:public:events");
  assert.deepEqual(
    partitionGroup(tableGroup!.children![0])?.children?.map((node) => node.label),
    ["events_2026"],
  );
});

test("buildGroupedObjectTreeNodes applies natural name sorting inside object groups", () => {
  const groups = buildGroupedObjectTreeNodes({
    nodeId: "conn:app:public",
    connectionId: "conn",
    database: "app",
    schema: "public",
    objects: [object("chat_staff"), object("chat_staff_his"), object("staff"), object("staff_his")],
  });

  const tableGroup = groups.find((node) => node.type === "group-tables");
  assert.deepEqual(
    tableGroup?.children?.map((node) => node.label),
    ["chat_staff", "chat_staff_his", "staff", "staff_his"],
  );
});

test("buildGroupedObjectTreeNodes groups Oracle packages and package bodies", () => {
  const groups = buildGroupedObjectTreeNodes({
    nodeId: "conn:app:HR",
    connectionId: "conn",
    database: "app",
    schema: "HR",
    objects: [
      { name: "PAYROLL", object_type: "PACKAGE", schema: "HR" },
      { name: "PAYROLL", object_type: "PACKAGE_BODY", schema: "HR" },
    ],
  });

  const packageGroup = groups.find((node) => node.type === "group-packages");
  assert.equal(packageGroup?.label, "tree.packages");
  assert.deepEqual(
    packageGroup?.children?.map((node) => ({ label: node.label, type: node.type, id: node.id })),
    [
      { label: "PAYROLL", type: "package", id: "conn:app:HR:__packages:HR:PAYROLL:PACKAGE" },
      { label: "PAYROLL", type: "package-body", id: "conn:app:HR:__packages:HR:PAYROLL:PACKAGE_BODY" },
    ],
  );
});

test("buildGroupedObjectTreeNodes groups materialized views separately from views", () => {
  const groups = buildGroupedObjectTreeNodes({
    nodeId: "conn:app:APP",
    connectionId: "conn",
    database: "app",
    schema: "APP",
    objects: [
      { name: "ACTIVE_USERS", object_type: "VIEW", schema: "APP" },
      { name: "USER_SUMMARY_MV", object_type: "MATERIALIZED_VIEW", schema: "APP" },
    ],
  });

  const viewGroup = groups.find((node) => node.type === "group-views");
  const materializedViewGroup = groups.find((node) => node.type === "group-materialized-views");
  assert.deepEqual(
    viewGroup?.children?.map((node) => ({ label: node.label, type: node.type })),
    [{ label: "ACTIVE_USERS", type: "view" }],
  );
  assert.deepEqual(
    materializedViewGroup?.children?.map((node) => ({ label: node.label, type: node.type })),
    [{ label: "USER_SUMMARY_MV", type: "materialized_view" }],
  );
});

test("buildObjectGroupPlaceholderNodes creates capability-driven lazy sidebar groups", () => {
  const groups = buildObjectGroupPlaceholderNodes({
    nodeId: "conn:app:HR",
    connectionId: "conn",
    database: "app",
    schema: "HR",
    objectTypes: ["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "SEQUENCE"],
  });

  assert.deepEqual(
    groups.map((node) => ({ label: node.label, type: node.type, count: node.objectCount, children: node.children })),
    [
      { label: "tree.tables", type: "group-tables", count: undefined, children: [] },
      { label: "tree.views", type: "group-views", count: undefined, children: [] },
      { label: "tree.procedures", type: "group-procedures", count: undefined, children: [] },
      { label: "tree.functions", type: "group-functions", count: undefined, children: [] },
      { label: "tree.sequences", type: "group-sequences", count: undefined, children: [] },
    ],
  );
});

test("buildSimpleObjectTreeNodes keeps routines, sequences, and packages visible in flat sidebar mode", () => {
  const nodes = buildSimpleObjectTreeNodes({
    nodeId: "conn:app:HR",
    connectionId: "conn",
    database: "app",
    schema: "HR",
    objects: [
      { name: "ORDERS", object_type: "TABLE", schema: "HR" },
      { name: "ACTIVE_ORDERS", object_type: "VIEW", schema: "HR" },
      { name: "REFRESH_STATS", object_type: "PROCEDURE", schema: "HR" },
      { name: "TOTAL_DUE", object_type: "FUNCTION", schema: "HR" },
      { name: "ORDER_ID_SEQ", object_type: "SEQUENCE", schema: "HR" },
      { name: "PAYROLL", object_type: "PACKAGE", schema: "HR" },
      { name: "PAYROLL", object_type: "PACKAGE_BODY", schema: "HR" },
    ],
  });

  assert.deepEqual(
    nodes.map((node) => ({ label: node.label, type: node.type })),
    [
      { label: "ORDERS", type: "table" },
      { label: "ACTIVE_ORDERS", type: "view" },
      { label: "ORDER_ID_SEQ", type: "sequence" },
      { label: "PAYROLL", type: "package" },
      { label: "PAYROLL", type: "package-body" },
      { label: "REFRESH_STATS", type: "procedure" },
      { label: "TOTAL_DUE", type: "function" },
    ],
  );
});

test("mergeTableInfosIntoObjects restores views missing from object metadata", () => {
  const merged = mergeTableInfosIntoObjects(
    [object("orders")],
    [
      table("orders"),
      {
        name: "active_orders",
        table_type: "VIEW",
        comment: "current orders",
        parent_schema: null,
        parent_name: null,
      },
    ],
    "public",
  );

  assert.deepEqual(
    merged.map((item) => ({ name: item.name, type: item.object_type, schema: item.schema, comment: item.comment })),
    [
      { name: "orders", type: "TABLE", schema: "public", comment: null },
      { name: "active_orders", type: "VIEW", schema: "public", comment: "current orders" },
    ],
  );
});

test("filterSimpleSidebarSupplementalObjects leaves paged tables and views to listTables", () => {
  const supplemental = filterSimpleSidebarSupplementalObjects([
    { name: "orders", object_type: "TABLE", schema: "public" },
    { name: "active_orders", object_type: "VIEW", schema: "public" },
    { name: "order_summary", object_type: "MATERIALIZED VIEW", schema: "public" },
    { name: "refresh_stats", object_type: "PROCEDURE", schema: "public" },
    { name: "total_due", object_type: "FUNCTION", schema: "public" },
  ]);
  const nodes = buildSimpleObjectTreeNodes({
    nodeId: "conn:app:public",
    connectionId: "conn",
    database: "app",
    schema: "public",
    objects: mergeTableInfosIntoObjects(supplemental, [table("orders")], "public"),
  });

  assert.deepEqual(
    nodes.map((node) => ({ label: node.label, type: node.type })),
    [
      { label: "orders", type: "table" },
      { label: "refresh_stats", type: "procedure" },
      { label: "total_due", type: "function" },
    ],
  );
});

test("mergeTableInfosIntoObjects dedupes MySQL tables when object metadata carries database as schema", () => {
  const merged = mergeTableInfosIntoObjects(
    [
      {
        name: "orders",
        object_type: "TABLE",
        schema: "app",
        comment: null,
        created_at: null,
        updated_at: null,
        parent_schema: null,
        parent_name: null,
      },
    ],
    [table("orders")],
  );

  assert.deepEqual(
    merged.map((item) => ({ name: item.name, type: item.object_type, schema: item.schema })),
    [{ name: "orders", type: "TABLE", schema: "app" }],
  );
});
