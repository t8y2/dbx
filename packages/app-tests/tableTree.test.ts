import test from "node:test";
import assert from "node:assert/strict";
import { buildGroupedObjectTreeNodes, buildTableTreeNodes } from "../../apps/desktop/src/lib/tableTree.ts";
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
