import { describe, expect, it } from "vitest";
import { appendTableTreeLoadMoreNode, buildGroupedObjectTreeNodes, buildSimpleObjectTreeNodes, buildTableTreeNodes, mergeTableTreePageChildren, tablePartitionGroups, withoutTableTreeLoadMoreNodes } from "@/lib/table/tableTree";
import type { ObjectInfo, TableInfo, TreeNode } from "@/types/database";

const context = {
  nodeId: "connection:db",
  connectionId: "connection",
  database: "db",
};

describe("PostgreSQL overloaded routines", () => {
  it("keeps routines with the same name distinct by identity arguments", () => {
    const objects: ObjectInfo[] = [
      { name: "calc", object_type: "FUNCTION", schema: "public", signature: "integer" },
      { name: "calc", object_type: "FUNCTION", schema: "public", signature: "integer, integer" },
      { name: "calc", object_type: "FUNCTION", schema: "public", signature: "numeric" },
    ];

    const nodes = buildSimpleObjectTreeNodes({ ...context, schema: "public", objects });

    expect(nodes.map((node) => ({ label: node.label, objectName: node.objectName, signature: node.signature }))).toEqual(
      expect.arrayContaining([
        { label: "calc(integer)", objectName: "calc", signature: "integer" },
        { label: "calc(integer, integer)", objectName: "calc", signature: "integer, integer" },
        { label: "calc(numeric)", objectName: "calc", signature: "numeric" },
      ]),
    );
    expect(new Set(nodes.map((node) => node.id)).size).toBe(3);
  });

  it("keeps grouped routine nodes distinct by identity arguments", () => {
    const objects: ObjectInfo[] = [
      { name: "calc", object_type: "FUNCTION", schema: "public", signature: "integer" },
      { name: "calc", object_type: "FUNCTION", schema: "public", signature: "integer, integer" },
      { name: "calc", object_type: "FUNCTION", schema: "public", signature: "numeric" },
    ];

    const groups = buildGroupedObjectTreeNodes({ ...context, schema: "public", objects });
    const functionGroup = groups.find((node) => node.type === "group-functions");

    expect(functionGroup?.children?.map((node) => ({ label: node.label, objectName: node.objectName, signature: node.signature }))).toEqual([
      { label: "calc(integer)", objectName: "calc", signature: "integer" },
      { label: "calc(integer, integer)", objectName: "calc", signature: "integer, integer" },
      { label: "calc(numeric)", objectName: "calc", signature: "numeric" },
    ]);
    expect(new Set(functionGroup?.children?.map((node) => node.id) ?? []).size).toBe(3);
  });
});

describe("programmable database objects", () => {
  it("keeps Xugu trigger/type nodes distinct and preserves an invalid status", () => {
    const objects: ObjectInfo[] = [
      { name: "TRG_AUDIT", object_type: "TRIGGER", schema: "APP", valid: false },
      { name: "ADDRESS_T", object_type: "TYPE", schema: "APP", valid: true },
      { name: "ADDRESS_T", object_type: "TYPE_BODY", schema: "APP", valid: true },
    ];

    const nodes = buildSimpleObjectTreeNodes({ ...context, schema: "APP", objects });

    expect(nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "trigger", objectName: "TRG_AUDIT", valid: false }), expect.objectContaining({ type: "type", objectName: "ADDRESS_T", valid: true }), expect.objectContaining({ type: "type-body", objectName: "ADDRESS_T", valid: true })]),
    );
  });
});

describe("PostgreSQL table hierarchy", () => {
  it("keeps schema pagination visible at the table-group root when a page ends inside nested partitions", () => {
    const nodes = buildTableTreeNodes({
      ...context,
      schema: "public",
      tables: [
        { name: "orders", table_type: "BASE TABLE", comment: null },
        { name: "orders_2026", table_type: "BASE TABLE", comment: null, parent_schema: "public", parent_name: "orders" },
        { name: "orders_2026_01", table_type: "BASE TABLE", comment: null, parent_schema: "public", parent_name: "orders_2026" },
      ],
    });
    const loadMore: TreeNode = {
      id: "load-more:1000",
      label: "tree.loadMore",
      type: "load-more",
      connectionId: context.connectionId,
      database: context.database,
      loadMore: { parentId: "connection:db:__tables", offset: 1000, pageSize: 1000 },
    };

    const withLoadMore = appendTableTreeLoadMoreNode(nodes, loadMore, { schema: "public", name: "orders_2026" });

    expect(withLoadMore.map((node) => node.label)).toEqual(["orders", "tree.loadMore"]);
    const yearPartition = tablePartitionGroups(withLoadMore[0])[0].children?.[0];
    expect(yearPartition?.label).toBe("orders_2026");
    expect(tablePartitionGroups(yearPartition!)[0].children?.map((node) => node.label)).toEqual(["orders_2026_01"]);
  });
});

describe("TDengine table hierarchy", () => {
  it("groups child tables under their supertable and keeps ordinary tables flat", () => {
    const tables: TableInfo[] = [
      { name: "meters", table_type: "STABLE", comment: null },
      { name: "device_b", table_type: "TABLE", comment: null, parent_name: "meters" },
      { name: "standalone", table_type: "TABLE", comment: null },
      { name: "device_a", table_type: "TABLE", comment: null, parent_name: "meters" },
    ];

    const nodes = buildTableTreeNodes({ ...context, tables });

    expect(nodes.map((node) => node.label)).toEqual(["meters", "standalone"]);
    expect(nodes[0].children).toHaveLength(1);
    expect(nodes[0].children?.[0]).toMatchObject({
      type: "group-partitions",
      label: "tree.childTables",
      objectCount: 2,
      isExpanded: true,
    });
    expect(nodes[0].children?.[0].children?.map((node) => node.label)).toEqual(["device_a", "device_b"]);
  });

  it("attaches child tables loaded on later pages to the existing supertable", () => {
    const firstPage = buildTableTreeNodes({
      ...context,
      tables: [{ name: "meters", table_type: "STABLE", comment: null }],
    });
    const secondPage = buildTableTreeNodes({
      ...context,
      tables: [{ name: "device_a", table_type: "TABLE", comment: null, parent_name: "meters" }],
    });

    const merged = mergeTableTreePageChildren(firstPage, secondPage, context.connectionId, context.database);

    expect(merged).toHaveLength(1);
    expect(merged[0].children?.[0]).toMatchObject({
      type: "group-partitions",
      label: "tree.childTables",
      objectCount: 1,
      isExpanded: true,
    });
    expect(merged[0].children?.[0].children?.[0].label).toBe("device_a");
  });

  it("keeps pagination inside the child table group across pages", () => {
    const firstPage = buildTableTreeNodes({
      ...context,
      tables: [
        { name: "meters", table_type: "STABLE", comment: null },
        { name: "device_a", table_type: "TABLE", comment: null, parent_name: "meters" },
      ],
    });
    const firstLoadMore: TreeNode = {
      id: "load-more:1",
      label: "tree.loadMore",
      type: "load-more",
      connectionId: context.connectionId,
      database: context.database,
      loadMore: { parentId: "connection:db:__tables", offset: 2, pageSize: 2 },
    };

    appendTableTreeLoadMoreNode(firstPage, firstLoadMore, { name: "meters" });

    expect(firstPage.map((node) => node.type)).toEqual(["table"]);
    expect(tablePartitionGroups(firstPage[0])[0].children?.map((node) => node.type)).toEqual(["table", "load-more"]);

    const secondPage = buildTableTreeNodes({
      ...context,
      tables: [{ name: "device_b", table_type: "TABLE", comment: null, parent_name: "meters" }],
    });
    const withoutLoadMore = withoutTableTreeLoadMoreNodes(firstPage);
    const merged = mergeTableTreePageChildren(withoutLoadMore, secondPage, context.connectionId, context.database);
    const secondLoadMore = { ...firstLoadMore, id: "load-more:2", loadMore: { ...firstLoadMore.loadMore!, offset: 4 } };

    appendTableTreeLoadMoreNode(merged, secondLoadMore, { name: "meters" });

    expect(merged).toHaveLength(1);
    expect(tablePartitionGroups(merged[0])[0]).toMatchObject({ objectCount: 2 });
    expect(tablePartitionGroups(merged[0])[0].children?.map((node) => node.label)).toEqual(["device_a", "device_b", "tree.loadMore"]);
  });

  it("keeps the partition label for non-TDengine parent tables", () => {
    const nodes = buildTableTreeNodes({
      ...context,
      schema: "public",
      tables: [
        { name: "orders", table_type: "PARTITIONED TABLE", comment: null },
        { name: "orders_2026", table_type: "TABLE", comment: null, parent_schema: "public", parent_name: "orders" },
      ],
    });

    expect(nodes[0].children?.[0]).toMatchObject({ label: "tree.partitions", isExpanded: false });
  });
});
