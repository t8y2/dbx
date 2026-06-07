import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGroupedObjectTreeNodes,
  buildTableTreeNodes,
  mergeTableInfosIntoObjects,
} from "../../apps/desktop/src/lib/tableTree.ts";
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
