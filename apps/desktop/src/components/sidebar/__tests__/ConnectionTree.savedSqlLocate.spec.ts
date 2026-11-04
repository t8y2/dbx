import { computed, nextTick, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { compileConnectionTreeTestScript } from "./connectionTreeTestScript";
import { flattenTree } from "@/composables/useFlatTree";
import { activeTabSidebarTarget, expandSidebarLocatePath, findNodePathForTarget, findSidebarConnectionNode, findSidebarNodeForTarget } from "@/lib/sidebar/sidebarActiveTabTarget";
import { connectionShouldDiscoverJdbcSchemas, connectionUsesConnectionRootSchemaMode, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { usesTreeSchemaMode } from "@/lib/database/databaseFeatureSupport";
import { buildDatabaseSavedSqlRootNode } from "@/lib/savedSql/savedSqlDatabaseTree";
import type { QueryTab, SavedSqlFile, TreeNode } from "@/types/database";

const script = compileConnectionTreeTestScript(["locateTabInSidebarTarget", "ensureTreeLoadedForTarget", "resolveLoadedLocateTarget", "findDorisCatalogNode", "findDatabaseNode", "sameTreeName", "expandSidebarNodePath"]);

describe("ConnectionTree saved SQL locate entry", () => {
  it.each([undefined, "external"])("reconnects the saved file context and selects its row instead of cursor SQL (catalog: %s)", async (catalog) => {
    const saved = { id: "saved", name: "report.sql", connectionId: "saved-connection", database: "reports", catalog } as SavedSqlFile;
    const database: TreeNode = { id: "database", type: "database", label: "reports", connectionId: saved.connectionId, database: saved.database, catalog };
    const root: TreeNode = { id: saved.connectionId, type: "connection", label: "Connection", connectionId: saved.connectionId };
    const config = { id: saved.connectionId, db_type: catalog ? "doris" : "mysql" };
    const loadContents = vi.fn(async () => {
      database.children = [buildDatabaseSavedSqlRootNode(database, [saved])!];
    });
    const store = {
      treeNodes: [root],
      connectedIds: new Set<string>(),
      getConfig: vi.fn(() => config),
      connect: vi.fn(async () => {
        store.connectedIds.add(saved.connectionId);
      }),
      loadDatabases: vi.fn(async () => {
        root.children = catalog ? [{ id: "catalog", type: "doris-catalog", label: catalog, catalog, connectionId: saved.connectionId, children: [database] }] : [database];
      }),
      loadTables: loadContents,
      loadDorisCatalogTables: loadContents,
      canUseLoadedTreeNodeToggle: (node: TreeNode) => !!node.children?.length,
      revealRelationalNavigationPath: vi.fn(),
      selectedTreeNodeId: "",
      selectedTreeNodeIds: [] as string[],
      treeSelectionAnchorId: "",
      connectionMultiSelectActive: true,
    };
    const cursorCandidate = vi.fn(() => ({ connectionId: "editor-connection", database: "editor-db", tableName: "unrelated" }));
    const scroll = vi.fn();
    const flash = vi.fn();
    const bindings = {
      store,
      savedSqlStore: { getFile: () => saved },
      activeTabSidebarTarget,
      queryCursorTableCandidate: cursorCandidate,
      effectiveDatabaseTypeForConnection,
      connectionUsesConnectionRootSchemaMode,
      connectionUsesDatabaseObjectTreeMode,
      connectionShouldDiscoverJdbcSchemas,
      usesTreeSchemaMode,
      findNodePathForTarget,
      findSidebarConnectionNode,
      findSidebarNodeForTarget,
      expandSidebarLocatePath,
      nextTick,
      isRootListPartial: ref(false),
      flatNodes: computed(() => flattenTree(store.treeNodes)),
      scrollToSidebarNode: scroll,
      flashSidebarNode: flash,
      toast: vi.fn(),
      t: (key: string) => key,
    };
    const locate = new Function(...Object.keys(bindings), `${script}; return locateTabInSidebarTarget;`)(...Object.values(bindings));
    await locate({ id: "tab", mode: "query", savedSqlId: saved.id, connectionId: "editor-connection", database: "editor-db", sql: "SELECT * FROM unrelated" } as QueryTab, "center");
    expect(store.connect).toHaveBeenCalledExactlyOnceWith(config);
    expect(store.loadDatabases).toHaveBeenCalledExactlyOnceWith(saved.connectionId, undefined);
    expect(loadContents).toHaveBeenCalledOnce();
    expect(cursorCandidate).not.toHaveBeenCalled();
    const fileNode = database.children![0]!.children![0]!;
    expect(store.selectedTreeNodeIds).toEqual([fileNode.id]);
    expect(store.selectedTreeNodeId).toBe(fileNode.id);
    expect(scroll).toHaveBeenCalledExactlyOnceWith(fileNode.id, { align: "center" });
    expect(flash).toHaveBeenCalledExactlyOnceWith(fileNode.id);
  });
});
