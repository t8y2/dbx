import { shallowRef } from "vue";
import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/types/database";

import { useSidebarTreeToolRuntime } from "@/composables/useSidebarTreeToolRuntime";

function setup(node: Partial<TreeNode>, options: { treeNodes?: TreeNode[]; selectedTreeNodeIds?: string[]; acceptedSelectionIds?: readonly string[] | null } = {}) {
  const activeNode = shallowRef({ id: "n-1", label: "node", children: [], ...node } as TreeNode);
  const connectionStore = {
    docsSource: null as unknown,
    dataDictionarySource: null as unknown,
    diagramSource: null as unknown,
    databaseExportSource: null as unknown,
    mongoImportSource: undefined as unknown,
    mongoDatabaseDumpSource: null as unknown,
    schemaDiffSource: null as unknown,
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

describe("useSidebarTreeToolRuntime openDataDictionary", () => {
  it("documents every schema when invoked on a database node", () => {
    const { connectionStore, runtime } = setup({ type: "database", label: "shop", connectionId: "conn-1", database: "shop" });

    runtime.openDataDictionary();

    expect(connectionStore.dataDictionarySource).toEqual({ connectionId: "conn-1", database: "shop", schema: undefined });
  });

  it("narrows to a schema node", () => {
    const { connectionStore, runtime } = setup({ type: "schema", label: "public", connectionId: "conn-1", database: "shop", schema: "public" });

    runtime.openDataDictionary();

    expect(connectionStore.dataDictionarySource).toEqual({ connectionId: "conn-1", database: "shop", schema: "public" });
  });

  it("exports the selected same-schema tables and views", () => {
    const publicUsers: TreeNode = { id: "t1", label: "users", type: "table", connectionId: "c1", database: "db", schema: "public" };
    const publicOrders: TreeNode = { id: "t2", label: "orders", type: "table", connectionId: "c1", database: "db", schema: "public" };
    const publicView: TreeNode = { id: "v1", label: "active_users", type: "view", connectionId: "c1", database: "db", schema: "public" };
    const salesUsers: TreeNode = { id: "t3", label: "users", type: "table", connectionId: "c1", database: "db", schema: "sales" };
    const group: TreeNode = { id: "group", label: "Tables", type: "group-tables", children: [publicUsers, publicOrders, publicView, salesUsers] };
    const { connectionStore, runtime } = setup(publicUsers, {
      treeNodes: [group],
      selectedTreeNodeIds: [publicOrders.id, publicUsers.id, publicView.id, salesUsers.id],
    });

    runtime.openDataDictionary();

    expect(connectionStore.dataDictionarySource).toEqual({
      connectionId: "c1",
      database: "db",
      schema: "public",
      tableNames: ["users", "orders", "active_users"],
    });
  });

  it("does nothing when the node carries no database", () => {
    const { connectionStore, runtime } = setup({ type: "connection", label: "local", connectionId: "conn-1" });

    runtime.openDataDictionary();

    expect(connectionStore.dataDictionarySource).toBeNull();
  });
});

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

describe("useSidebarTreeToolRuntime mongo import", () => {
  it("opens collection import from a mongo-collection node", () => {
    const { connectionStore, runtime } = setup({
      type: "mongo-collection",
      label: "orders",
      connectionId: "conn-1",
      database: "shop",
    });

    runtime.openMongoImport();

    expect(connectionStore.mongoImportSource).toEqual({
      connectionId: "conn-1",
      database: "shop",
      collection: "orders",
    });
  });
});

describe("useSidebarTreeToolRuntime MongoDB dump and restore", () => {
  it.each(["dump", "restore"] as const)("opens %s for the selected MongoDB database", (mode) => {
    const { connectionStore, runtime } = setup({ type: "mongo-db", connectionId: "conn-1", database: "shop" });

    runtime.openMongoDatabaseDump(mode);

    expect(connectionStore.mongoDatabaseDumpSource).toEqual({ connectionId: "conn-1", database: "shop", mode });
  });

  it.each<Partial<TreeNode>>([
    { type: "table", connectionId: "conn-1", database: "shop" },
    { type: "mongo-collection", connectionId: "conn-1", database: "shop" },
    { type: "mongo-db", database: "shop" },
    { type: "mongo-db", connectionId: "conn-1" },
  ])("does not open a database restore from an invalid context: %j", (node) => {
    const { connectionStore, runtime } = setup(node);

    runtime.openMongoDatabaseDump("restore");

    expect(connectionStore.mongoDatabaseDumpSource).toBeNull();
  });
});

describe("useSidebarTreeToolRuntime openSchemaDiffForRoutine", () => {
  it("prefills schema diff with a signature-aware routine key", () => {
    const { connectionStore, runtime } = setup({
      type: "function",
      label: "add(integer)",
      objectName: "add",
      signature: "integer",
      connectionId: "conn-1",
      database: "shop",
      schema: "public",
    });

    runtime.openSchemaDiffForRoutine();

    expect(connectionStore.schemaDiffSource).toEqual({
      connectionId: "conn-1",
      database: "shop",
      schema: "public",
      selectedRoutines: ["add(integer)"],
      preferredResultTab: "routines",
    });
  });
});
