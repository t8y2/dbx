import { computed, effectScope, nextTick, reactive, ref, type Ref } from "vue";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useSidebarSearchIndexes } from "@/composables/useSidebarSearchIndexes";
import { useSidebarRemoteSearch } from "@/composables/useSidebarRemoteSearch";
import { connectionShouldDiscoverJdbcSchemas, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { usesTreeSchemaMode } from "@/lib/database/databaseFeatureSupport";
import { collectSidebarGlobalSearchIndexes, sidebarIndexedObjectGroupTypes } from "@/lib/sidebar/sidebarGlobalSearchIndex";
import { collectSidebarRemoteSearchResults, type SidebarRemoteSearchResult } from "@/lib/sidebar/sidebarRemoteSearch";
import { findNodePathByIdentity, type SidebarRegexIndexScope } from "@/lib/sidebar/sidebarSearchTree";
import { resolveSidebarSearchDatabaseScope } from "@/lib/sidebar/sidebarSearchDatabaseScope";
import type { TableInfo, TreeNode } from "@/types/database";
import { runSidebarSearchTasks } from "../sidebarSearchTaskRunner";
import { compileConnectionTreeTestScript } from "./connectionTreeTestScript";

const compiled = compileConnectionTreeTestScript(["globalSearchConnectionRoots", "globalSearchContext", "globalTableSearchScopes", "remoteSearchResults", "loadGlobalTableSearchIndexes", "loadGlobalRemoteSearchResults", "isGlobalTableIndexParent", "discoverGlobalSearchChildren"]);
const cleanups: Array<() => void> = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

function fixture(display: "grouped" | "simple" = "grouped") {
  const searchQuery = ref("");
  const loadedIds = reactive(new Set(["conn"]));
  const databases = reactive<TreeNode[]>(["app", "other"].map((database) => ({ id: `conn:${database}`, label: database, type: "database", connectionId: "conn", database, isExpanded: false, children: [] })));
  const settingsStore = reactive({ editorSettings: { sidebarGlobalSearchLocal: false, sidebarObjectDisplay: display, sidebarSearchOpenedDatabasesOnly: true } });
  const queryStore = reactive({ openDatabaseKeys: new Set<string>() });
  const store = reactive({
    activeConnectionId: "conn",
    connectedIds: new Set(["conn"]),
    treeNodes: [{ id: "conn", label: "north", type: "connection", connectionId: "conn", isExpanded: true, children: databases }] as TreeNode[],
    sidebarTableSearchIndexInvalidation: { revision: 0 },
    sidebarObjectSearchRevision: 0,
    isTreeNodeChildrenLoaded: (nodeId: string) => loadedIds.has(nodeId),
    getConfig: () => ({ db_type: "mysql" as const }),
    loadSidebarTableSearchIndexScopes: vi.fn(async () => []),
    loadConnectedConnectionRootForSidebarSearch: vi.fn(),
    loadTreeNodeChildren: vi.fn(async (node: TreeNode) => openDatabase(node)),
    ensureSidebarTableSearchIndex: vi.fn(async (): Promise<TableInfo[]> => [{ name: "late_orders", table_type: "TABLE" }]),
    searchSidebarObjects: vi.fn(async (node: TreeNode): Promise<TreeNode[]> => [{ id: `${node.id}:routine`, label: "late_routine", type: "procedure", connectionId: node.connectionId, database: node.database }]),
  });
  const onError = vi.fn();
  const bindings = {
    computed,
    searchQuery,
    deferredSearchQuery: searchQuery,
    regexMode: ref(false),
    settingsStore,
    queryStore,
    store,
    selectedSearchScopes: ref([]),
    searchableNodeTypes: ref(undefined),
    useSidebarSearchIndexes,
    useSidebarRemoteSearch,
    collectSidebarGlobalSearchIndexes,
    runSidebarSearchTasks,
    collectSidebarRemoteSearchResults,
    findNodePathByIdentity,
    sidebarIndexedObjectGroupTypes,
    resolveSidebarSearchDatabaseScope,
    connectionShouldDiscoverJdbcSchemas,
    connectionUsesDatabaseObjectTreeMode,
    effectiveDatabaseTypeForConnection,
    usesTreeSchemaMode,
    toast: onError,
  };
  const scope = effectScope();
  const state = scope.run(
    () =>
      new Function(...Object.keys(bindings), `${compiled}; return { globalTableSearchScopes, remoteSearchResults };`)(...Object.values(bindings)) as {
        globalTableSearchScopes: Ref<SidebarRegexIndexScope[]>;
        remoteSearchResults: Ref<SidebarRemoteSearchResult[]>;
      },
  )!;
  cleanups.push(() => scope.stop());

  function openDatabase(node: TreeNode) {
    node.children =
      display === "grouped"
        ? [
            { id: `${node.id}:tables`, label: "Tables", type: "group-tables", connectionId: node.connectionId, database: node.database, isExpanded: false, children: [] },
            { id: `${node.id}:procedures`, label: "Procedures", type: "group-procedures", connectionId: node.connectionId, database: node.database, isExpanded: false, children: [] },
          ]
        : [{ id: `${node.id}:first_page`, label: "first_page", type: "table", connectionId: node.connectionId, database: node.database }];
    node.isExpanded = true;
    loadedIds.add(node.id);
  }

  return { ...state, searchQuery, databases, store, settingsStore, queryStore, loadedIds, openDatabase, onError };
}

function addConnection(view: ReturnType<typeof fixture>, connectionId: string, connected = true) {
  const database = reactive<TreeNode>({ id: `${connectionId}:app`, label: "app", type: "database", connectionId, database: "app", children: [] });
  view.store.treeNodes.push({ id: `folder:${connectionId}`, label: "Folder", type: "connection-group", children: [{ id: connectionId, label: connectionId, type: "connection", connectionId, children: [database] }] });
  view.loadedIds.add(connectionId);
  if (connected) view.store.connectedIds.add(connectionId);
  return database;
}

test.each(["grouped", "simple"] as const)("aggregates same-name tables across connected roots in %s mode without an active connection", async (display) => {
  const view = fixture(display);
  view.openDatabase(view.databases[0]);
  view.openDatabase(addConnection(view, "second"));
  view.openDatabase(addConnection(view, "offline", false));
  view.store.activeConnectionId = "";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    view.searchQuery.value = "late";
    await vi.advanceTimersByTimeAsync(350);
    expect(view.globalTableSearchScopes.value.map((scope) => [scope.connectionId, scope.entries[0].name]).sort()).toEqual([
      ["conn", "late_orders"],
      ["second", "late_orders"],
    ]);
    expect(view.remoteSearchResults.value.map((scope) => scope.connectionId).sort()).toEqual(["conn", "second"]);
    view.searchQuery.value = "";
    await vi.advanceTimersByTimeAsync(350);
  }
  expect(view.store.loadTreeNodeChildren).not.toHaveBeenCalled();
  expect(view.onError).not.toHaveBeenCalled();
});

test("opening a database on an inactive connection refreshes search without resetting on selection changes", async () => {
  const view = fixture();
  view.openDatabase(view.databases[0]);
  const other = addConnection(view, "second");
  view.searchQuery.value = "late";
  await vi.advanceTimersByTimeAsync(350);
  expect(view.globalTableSearchScopes.value.map((scope) => scope.connectionId)).toEqual(["conn"]);

  view.openDatabase(other);
  await vi.advanceTimersByTimeAsync(350);
  expect(view.globalTableSearchScopes.value.map((scope) => scope.connectionId).sort()).toEqual(["conn", "second"]);
  expect(view.remoteSearchResults.value.map((scope) => scope.connectionId).sort()).toEqual(["conn", "second"]);
  const tableCalls = view.store.ensureSidebarTableSearchIndex.mock.calls.length;
  const remoteCalls = view.store.searchSidebarObjects.mock.calls.length;
  view.store.activeConnectionId = "second";
  await vi.advanceTimersByTimeAsync(350);
  expect(view.store.ensureSidebarTableSearchIndex).toHaveBeenCalledTimes(tableCalls);
  expect(view.store.searchSidebarObjects).toHaveBeenCalledTimes(remoteCalls);
  expect(view.store.loadTreeNodeChildren).not.toHaveBeenCalled();
});

test.each(["complete", "disconnect"])("publishes a second connection while the first is pending and handles its late %s", async (action) => {
  const view = fixture();
  view.openDatabase(view.databases[0]);
  view.openDatabase(addConnection(view, "second"));
  let finishIndex!: (entries: TableInfo[]) => void;
  let finishRemote!: (nodes: TreeNode[]) => void;
  view.store.ensureSidebarTableSearchIndex.mockImplementationOnce(() => new Promise((resolve) => (finishIndex = resolve)));
  view.store.searchSidebarObjects.mockImplementationOnce(() => new Promise((resolve) => (finishRemote = resolve)));
  view.searchQuery.value = "late";
  await vi.advanceTimersByTimeAsync(350);

  expect(view.globalTableSearchScopes.value.map((scope) => scope.connectionId)).toEqual(["second"]);
  expect(view.remoteSearchResults.value.map((scope) => scope.connectionId)).toEqual(["second"]);
  if (action === "disconnect") {
    view.store.connectedIds.delete("conn");
    await vi.advanceTimersByTimeAsync(350);
  }
  finishIndex([{ name: "late_orders", table_type: "TABLE" }]);
  finishRemote([{ id: "conn:app:routine", label: "late_routine", type: "procedure", connectionId: "conn", database: "app" }]);
  await vi.advanceTimersByTimeAsync(0);

  const expected = action === "complete" ? ["conn", "second"] : ["second"];
  expect(view.globalTableSearchScopes.value.map((scope) => scope.connectionId).sort()).toEqual(expected);
  expect(view.remoteSearchResults.value.map((scope) => scope.connectionId).sort()).toEqual(expected);
  expect(view.onError).not.toHaveBeenCalled();
});

test("keeps another connection's table and routine results when one connection fails", async () => {
  const view = fixture();
  view.openDatabase(view.databases[0]);
  view.openDatabase(addConnection(view, "second"));
  view.store.loadSidebarTableSearchIndexScopes.mockRejectedValueOnce(new Error("cache unavailable"));
  view.store.searchSidebarObjects.mockRejectedValueOnce(new Error("metadata unavailable"));
  view.searchQuery.value = "late";
  await vi.advanceTimersByTimeAsync(350);

  expect(view.globalTableSearchScopes.value.map((scope) => scope.connectionId)).toEqual(["second"]);
  expect(view.remoteSearchResults.value.map((scope) => scope.connectionId)).toEqual(["second"]);
  expect(view.onError).toHaveBeenCalledTimes(2);
});

test.each(["grouped", "simple"] as const)("indexes a database opened during %s search without clearing the query", async (display) => {
  const view = fixture(display);
  view.searchQuery.value = "north";
  await vi.advanceTimersByTimeAsync(350);
  expect(view.store.ensureSidebarTableSearchIndex).not.toHaveBeenCalled();
  expect(view.store.loadTreeNodeChildren).not.toHaveBeenCalled();

  view.openDatabase(view.databases[0]);
  await vi.advanceTimersByTimeAsync(350);
  view.searchQuery.value = "late_orders";
  await vi.advanceTimersByTimeAsync(350);

  expect(view.store.ensureSidebarTableSearchIndex).toHaveBeenCalledOnce();
  expect(view.globalTableSearchScopes.value.flatMap((scope) => scope.entries.map((entry) => entry.name))).toEqual(["late_orders"]);
  expect(view.remoteSearchResults.value.every((scope) => scope.database === "app")).toBe(true);
  expect(view.remoteSearchResults.value).not.toEqual([]);
  expect(view.store.loadTreeNodeChildren).not.toHaveBeenCalled();
  expect(view.loadedIds.has(view.databases[1].id)).toBe(false);
  expect(view.onError).not.toHaveBeenCalled();

  // Browsing within the opened database must not restart a complete index build.
  view.databases[0].isExpanded = false;
  view.databases[0].isExpanded = true;
  view.databases[0].children?.push({ id: "metadata", label: "metadata", type: "table" });
  await vi.advanceTimersByTimeAsync(350);
  expect(view.store.ensureSidebarTableSearchIndex).toHaveBeenCalledOnce();
});

test("discards an in-flight index when the database is closed during search", async () => {
  const view = fixture();
  let finish!: (entries: TableInfo[]) => void;
  view.store.ensureSidebarTableSearchIndex.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  view.searchQuery.value = "north";
  await vi.advanceTimersByTimeAsync(350);
  view.openDatabase(view.databases[0]);
  await vi.advanceTimersByTimeAsync(350);
  expect(view.store.ensureSidebarTableSearchIndex).toHaveBeenCalledOnce();

  view.loadedIds.delete(view.databases[0].id);
  await vi.advanceTimersByTimeAsync(350);
  finish([{ name: "stale_orders", table_type: "TABLE" }]);
  await nextTick();
  await nextTick();

  expect(view.globalTableSearchScopes.value).toEqual([]);
  expect(view.remoteSearchResults.value).toEqual([]);
  expect(view.onError).not.toHaveBeenCalled();
});

test("includes databases referenced by new editor tabs without opening other databases", async () => {
  const view = fixture();
  view.searchQuery.value = "north";
  await vi.advanceTimersByTimeAsync(350);
  view.queryStore.openDatabaseKeys.add("conn\x00other");
  await vi.advanceTimersByTimeAsync(700);

  expect(view.globalTableSearchScopes.value.map((scope) => scope.database)).toEqual(["other"]);
  expect(view.store.ensureSidebarTableSearchIndex).toHaveBeenCalledOnce();
  expect(view.loadedIds.has(view.databases[0].id)).toBe(false);
  expect(view.onError).not.toHaveBeenCalled();
});
