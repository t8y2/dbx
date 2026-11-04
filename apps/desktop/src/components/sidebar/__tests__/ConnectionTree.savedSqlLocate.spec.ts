import { computed, nextTick, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { compileConnectionTreeTestScript } from "./connectionTreeTestScript";
import { flattenTree } from "@/composables/useFlatTree";
import { activeTabSidebarTarget, expandSidebarLocatePath, findNodePathForTarget, findSidebarConnectionNode, findSidebarNodeForTarget } from "@/lib/sidebar/sidebarActiveTabTarget";
import { connectionShouldDiscoverJdbcSchemas, connectionUsesConnectionRootSchemaMode, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { usesTreeSchemaMode } from "@/lib/database/databaseFeatureSupport";
import { queryContextTargetFromCandidate, queryCursorTableCandidate } from "@/lib/sql/queryCursorTableTarget";
import type { QueryTab, SavedSqlFile, TreeNode } from "@/types/database";

const script = compileConnectionTreeTestScript(["locateTabInSidebarTarget", "ensureTreeLoadedForTarget", "resolveLoadedLocateTarget", "tableLocateCandidateFromTarget", "findDorisCatalogNode", "findDatabaseNode", "sameTreeName", "expandSidebarNodePath"]);

describe("ConnectionTree saved SQL locate entry", () => {
  it.each([undefined, "external"])("reconnects the execution context while preserving the SQL library association (catalog: %s)", async (catalog) => {
    const saved = { id: "saved", name: "report.sql", connectionId: "saved-connection", database: "reports", sql: "SELECT 1" } as SavedSqlFile;
    const tab = { id: "tab", mode: "query", savedSqlId: saved.id, connectionId: "editor-connection", database: "editor-db", catalog, sql: "SELECT 2" } as QueryTab;
    const originalTab = { ...tab };
    const originalSaved = { ...saved };
    const database: TreeNode = { id: "database", type: "database", label: tab.database, connectionId: tab.connectionId, database: tab.database, catalog };
    const root: TreeNode = { id: tab.connectionId, type: "connection", label: "Connection", connectionId: tab.connectionId };
    const config = { id: tab.connectionId, db_type: catalog ? "doris" : "mysql" };
    const loadContents = vi.fn();
    const store = {
      treeNodes: [root],
      connectedIds: new Set<string>(),
      getConfig: vi.fn(() => config),
      connect: vi.fn(async () => {
        store.connectedIds.add(tab.connectionId);
      }),
      loadDatabases: vi.fn(async () => {
        root.children = catalog ? [{ id: "catalog", type: "doris-catalog", label: catalog, catalog, connectionId: tab.connectionId, children: [database] }] : [database];
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
    const cursorCandidate = vi.fn(queryCursorTableCandidate);
    const scroll = vi.fn();
    const flash = vi.fn();
    const bindings = {
      store,
      activeTabSidebarTarget,
      queryCursorTableCandidate: cursorCandidate,
      queryContextTargetFromCandidate,
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
    await locate(tab, "center");
    expect(store.connect).toHaveBeenCalledExactlyOnceWith(config);
    expect(store.loadDatabases).toHaveBeenCalledExactlyOnceWith(tab.connectionId, undefined);
    expect(store.connectedIds.has(saved.connectionId)).toBe(false);
    expect(loadContents).not.toHaveBeenCalled();
    expect(cursorCandidate).toHaveBeenCalledOnce();
    expect(store.selectedTreeNodeIds).toEqual([database.id]);
    expect(store.selectedTreeNodeId).toBe(database.id);
    expect(scroll).toHaveBeenCalledExactlyOnceWith(database.id, { align: "center" });
    expect(flash).toHaveBeenCalledExactlyOnceWith(database.id);
    expect(tab).toEqual(originalTab);
    expect(saved).toEqual(originalSaved);
  });
});
