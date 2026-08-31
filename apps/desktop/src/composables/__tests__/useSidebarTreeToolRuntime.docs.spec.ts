import { shallowRef } from "vue";
import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/types/database";

import { useSidebarTreeToolRuntime } from "@/composables/useSidebarTreeToolRuntime";

function setup(node: Partial<TreeNode>, options: { treeNodes?: TreeNode[]; selectedTreeNodeIds?: string[]; acceptedSelectionIds?: readonly string[] | null } = {}) {
  const activeNode = shallowRef({ id: "n-1", label: "node", children: [], ...node } as TreeNode);
  const connectionStore = {
    docsSource: null as unknown,
    diagramSource: null as unknown,
    databaseExportSource: null as unknown,
    treeNodes: options.treeNodes ?? [],
    selectedTreeNodeIds: options.selectedTreeNodeIds ?? [],
  };
  const runtime = useSidebarTreeToolRuntime({
    activeNode,
    connectionStore: connectionStore as never,
    queryStore: {} as never,
    settingsStore: {} as never,
    tableChildObjectName: () => "",
    acceptedSelectionIds: () => options.acceptedSelectionIds ?? null,
  });
  return { connectionStore, runtime };
}

describe("useSidebarTreeToolRuntime openDocs", () => {
  it("documents the whole database when invoked on a database node", () => {
    const { connectionStore, runtime } = setup({ type: "database", label: "shop", connectionId: "conn-1", database: "shop" });

    runtime.openDocs();

    // An absent schema is what makes the collector document every schema.
    expect(connectionStore.docsSource).toEqual({ connectionId: "conn-1", database: "shop", schema: undefined });
  });

  it("narrows to a single schema when invoked on a schema node", () => {
    const { connectionStore, runtime } = setup({ type: "schema", label: "public", connectionId: "conn-1", database: "shop", schema: "public" });

    runtime.openDocs();

    expect(connectionStore.docsSource).toEqual({ connectionId: "conn-1", database: "shop", schema: "public" });
  });

  it("does nothing when the node carries no database", () => {
    const { connectionStore, runtime } = setup({ type: "connection", label: "local", connectionId: "conn-1" });

    runtime.openDocs();

    expect(connectionStore.docsSource).toBeNull();
  });
});

describe("useSidebarTreeToolRuntime diagram and database export", () => {
  const publicUsers: TreeNode = { id: "t1", label: "users", type: "table", connectionId: "c1", database: "db", schema: "public" };
  const publicOrders: TreeNode = { id: "t2", label: "orders", type: "table", connectionId: "c1", database: "db", schema: "public" };
  const salesUsers: TreeNode = { id: "t3", label: "users", type: "table", connectionId: "c1", database: "db", schema: "sales" };
  const publicView: TreeNode = { id: "v1", label: "active_users", type: "view", connectionId: "c1", database: "db", schema: "public" };
  const group: TreeNode = { id: "group", label: "Tables", type: "group-tables", children: [publicUsers, publicOrders, salesUsers, publicView] };

  it("opens a multi-table diagram only for tables in the active schema", () => {
    const { connectionStore, runtime } = setup(publicUsers, {
      treeNodes: [group],
      selectedTreeNodeIds: [publicOrders.id, publicUsers.id, salesUsers.id],
    });

    runtime.openDiagram();

    expect(connectionStore.diagramSource).toEqual({
      connectionId: "c1",
      database: "db",
      schema: "public",
      tableName: "users",
      tableNames: ["users", "orders"],
    });
  });

  it("prefills database export with same-schema tables only", () => {
    const { connectionStore, runtime } = setup(publicUsers, {
      treeNodes: [group],
      selectedTreeNodeIds: [publicOrders.id, publicUsers.id, publicView.id],
    });

    runtime.openDatabaseExport();

    expect(connectionStore.databaseExportSource).toEqual({
      connectionId: "c1",
      database: "db",
      schema: "public",
      tableNames: ["users", "orders"],
    });
  });

  it("falls back to single-table database export when the selection spans schemas", () => {
    const { connectionStore, runtime } = setup(publicUsers, {
      treeNodes: [group],
      selectedTreeNodeIds: [salesUsers.id, publicUsers.id],
    });

    runtime.openDatabaseExport();

    expect(connectionStore.databaseExportSource).toEqual({
      connectionId: "c1",
      database: "db",
      schema: "public",
      tableName: "users",
    });
  });
});
