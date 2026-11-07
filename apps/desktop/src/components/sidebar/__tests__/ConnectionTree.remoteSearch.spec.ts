// @vitest-environment happy-dom
import { computed, createApp, defineComponent, h, nextTick, reactive, ref } from "vue";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useSidebarRemoteSearch } from "@/composables/useSidebarRemoteSearch";
import { collectSidebarRemoteSearchResults, mergeSidebarRemoteSearchResults, type SidebarRemoteSearchResult } from "@/lib/sidebar/sidebarRemoteSearch";
import { filterLocallySearchedTables, filterSidebarSearchRootsByConnectionState, filterSidebarTree, filterSidebarTreeToConnectedConnections, findNodePathByIdentity, mergeSidebarRegexIndexScopes, type SidebarRegexIndexScope } from "@/lib/sidebar/sidebarSearchTree";
import { createSidebarLabelMatcher } from "@/lib/sidebar/sidebarSearch";
import { sortConnectionListForDisplay } from "@/lib/sidebar/connectionListSort";
import { orderSidebarConnectionUtilitiesForDisplay } from "@/lib/sidebar/sidebarNodeOrdering";
import { sidebarIndexedObjectGroupTypes } from "@/lib/sidebar/sidebarGlobalSearchIndex";
import { resolveSidebarSearchDatabaseScope } from "@/lib/sidebar/sidebarSearchDatabaseScope";
import type { TreeNode } from "@/types/database";
import { runSidebarSearchTasks } from "../sidebarSearchTaskRunner";
import { compileConnectionTreeTestScript } from "./connectionTreeTestScript";
import { sidebarNavigationSettings } from "@/lib/sidebar/sidebarNavigationPreferences";
import { sidebarDatabaseOpenKey } from "@/lib/sidebar/sidebarDatabaseOpenState";

const compiled = compileConnectionTreeTestScript(["globalSearchConnectionRoots", "loadGlobalRemoteSearchResults", "isGlobalTableIndexParent", "discoverGlobalSearchChildren", "globalSearchContext", "remoteSearchResults"]);
const compiledProjection = compileConnectionTreeTestScript(["filterGloballyIndexedTables", "localSearchTreeNodes", "mergedSearchTreeNodes", "filteredNodes"]);
const cleanups: Array<() => void> = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  document.body.replaceChildren();
});

function mountSearch() {
  const searchQuery = ref("");
  const regexMode = ref(false);
  const settingsStore = reactive({ editorSettings: { sidebarGlobalSearchLocal: false, sidebarObjectDisplay: "grouped", sidebarSearchOpenedDatabasesOnly: false } });
  const group: TreeNode = { id: "conn:app:__procedures", connectionId: "conn", database: "app", type: "group-procedures", label: "Procedures", children: [] };
  const root: TreeNode = { id: "conn", connectionId: "conn", type: "connection", label: "Connection", children: [group] };
  const store = reactive({
    relationalNavigationSelections: {},
    projectRelationalNavigationTree: vi.fn((nodes: readonly TreeNode[]) => nodes),
    relationalNavigationAllowsScope: () => true,
    relationalNavigationSearchChildren: (node: TreeNode) => node.children ?? [],
    activeConnectionId: "conn",
    connectedIds: new Set(["conn"]),
    treeNodes: [root],
    sidebarTableSearchIndexInvalidation: { revision: 0 },
    sidebarObjectSearchRevision: 0,
    isTreeNodeChildrenLoaded: vi.fn((_nodeId: string) => true),
    searchSidebarObjects: vi.fn(async (_node: TreeNode, _query: string, _signal: AbortSignal): Promise<TreeNode[]> => []),
    loadTreeNodeChildren: vi.fn(),
    loadConnectedConnectionRootForSidebarSearch: vi.fn(),
  });
  const toast = vi.fn();
  const queryStore = reactive({ openDatabaseKeys: new Set<string>() });
  const bindings = {
    ref,
    computed,
    searchQuery,
    regexMode,
    settingsStore,
    sidebarNavigationSettings,
    store,
    toast,
    queryStore,
    selectedSearchScopes: ref([]),
    searchableNodeTypes: ref(undefined),
    useSidebarRemoteSearch,
    runSidebarSearchTasks,
    collectSidebarRemoteSearchResults,
    findNodePathByIdentity,
    sidebarIndexedObjectGroupTypes,
    resolveSidebarSearchDatabaseScope,
  };
  let state!: { remoteSearchResults: { value: SidebarRemoteSearchResult[] }; isRemoteSearchLoading: { value: boolean } };
  const app = createApp(
    defineComponent({
      setup() {
        state = new Function(...Object.keys(bindings), `${compiled}; return { remoteSearchResults, isRemoteSearchLoading };`)(...Object.values(bindings));
        return () =>
          h("input", {
            placeholder: "Search...",
            value: searchQuery.value,
            onInput: (event: Event) => {
              searchQuery.value = (event.target as HTMLInputElement).value;
            },
          });
      },
    }),
  );
  const host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  cleanups.push(() => app.unmount());
  const input = host.querySelector("input")!;
  const type = (query: string) => {
    input.value = query;
    input.dispatchEvent(new Event("input"));
  };
  return { ...state, store, settingsStore, queryStore, regexMode, toast, type, app };
}

function mountSearchProjection() {
  const identity = { connectionId: "conn", database: "app", schema: "public" };
  const live: TreeNode = { ...identity, id: "routine", type: "procedure", label: "DBX_BASE", children: [] };
  const group: TreeNode = { ...identity, id: "procedures", type: "group-procedures", label: "Procedures", children: [live] };
  const store = reactive({
    treeNodes: [{ id: "conn", connectionId: "conn", type: "connection", label: "Connection", children: [group, { ...identity, id: "tables", type: "group-tables", label: "Tables", children: [] }] }] as TreeNode[],
    connectedIds: new Set(["conn"]),
    sidebarTableSearchQueries: {},
    projectRelationalNavigationTree: vi.fn((nodes: TreeNode[]) => nodes),
  });
  const remoteSearchResults = ref<SidebarRemoteSearchResult[]>([]);
  const globalTableSearchScopes = ref<SidebarRegexIndexScope[]>([]);
  const deferredSearchQuery = ref("DBX");
  const regexMode = ref(false);
  const searchableNodeTypes = ref<ReadonlySet<TreeNode["type"]>>();
  const bindings = {
    computed,
    store,
    remoteSearchResults,
    globalTableSearchScopes,
    deferredSearchQuery,
    regexMode,
    searchableNodeTypes,
    settingsStore: reactive({ editorSettings: { sidebarTableSearchLocal: false, sidebarConnectionSortMode: "default" } }),
    showConnectedConnectionsOnly: ref(false),
    localTableSearchResults: ref({}),
    searchCollapsedIds: ref(new Set()),
    searchExpandedIds: ref(new Set()),
    searchMatchMode: ref("fuzzy"),
    filterLocallySearchedTables,
    filterSidebarSearchRootsByConnectionState,
    filterSidebarTree,
    filterSidebarTreeToConnectedConnections,
    mergeSidebarRegexIndexScopes,
    mergeSidebarRemoteSearchResults,
    createSidebarLabelMatcher,
    sortConnectionListForDisplay,
    orderSidebarConnectionUtilitiesForDisplay,
    t: (key: string) => key,
  };
  const app = createApp(
    defineComponent({
      setup() {
        const { filteredNodes } = new Function(...Object.keys(bindings), `${compiledProjection}; return { filteredNodes };`)(...Object.values(bindings));
        return () => h("pre", JSON.stringify(filteredNodes.value));
      },
    }),
  );
  const host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  cleanups.push(() => app.unmount());
  return {
    store,
    host,
    remoteSearchResults,
    globalTableSearchScopes,
    deferredSearchQuery,
    regexMode,
    searchableNodeTypes,
    live: store.treeNodes[0].children![0].children![0],
    result: (children: TreeNode[]): SidebarRemoteSearchResult => ({ ...identity, parentNodeId: group.id, nodeType: group.type, children }),
  };
}

test("unchanged remote progress reuses the component projection while new results remain visible", async () => {
  const view = mountSearchProjection();
  view.store.projectRelationalNavigationTree.mockClear();
  for (let index = 0; index < 4; index++) {
    view.remoteSearchResults.value = [view.result([{ ...view.live, label: "stale response" }])];
    await nextTick();
  }
  expect(view.store.projectRelationalNavigationTree).not.toHaveBeenCalled();
  expect(view.host.textContent).toContain("DBX_BASE");
  expect(view.host.textContent).not.toContain("stale response");
  view.remoteSearchResults.value = [view.result([view.live, { id: "special", type: "procedure", label: "DBX_SPECIAL" }])];
  await nextTick();
  expect(view.store.projectRelationalNavigationTree).toHaveBeenCalledOnce();
  expect(view.host.textContent).toContain("DBX_SPECIAL");
});

test("component projection remains reactive to leaf metadata and query regex scope and index changes", async () => {
  const view = mountSearchProjection();
  view.remoteSearchResults.value = [view.result([view.live])];
  await nextTick();
  view.live.label = "renamed";
  view.live.comment = "DBX comment";
  await nextTick();
  expect(view.host.textContent).toContain("renamed");
  expect(view.host.textContent).toContain("DBX comment");
  view.live.comment = "not matching";
  await nextTick();
  expect(view.host.textContent).not.toContain("renamed");
  view.deferredSearchQuery.value = "^renamed$";
  view.regexMode.value = true;
  await nextTick();
  expect(view.host.textContent).toContain("renamed");
  view.searchableNodeTypes.value = new Set(["table"]);
  await nextTick();
  expect(view.host.textContent).not.toContain("renamed");
  view.globalTableSearchScopes.value = [{ parentNodeId: "tables", nodeType: "group-tables", connectionId: "conn", database: "app", schema: "public", entries: [{ name: "renamed", table_type: "TABLE" }] }];
  await nextTick();
  expect(view.host.textContent).toContain("renamed");
  expect(view.host.textContent).toContain('"type":"table"');
  view.globalTableSearchScopes.value = [];
  await nextTick();
  expect(view.host.textContent).not.toContain("renamed");
});

test("metadata invalidation bursts reuse the unchanged opened database scope projection", () => {
  const view = mountSearch();
  view.settingsStore.editorSettings.sidebarSearchOpenedDatabasesOnly = true;
  view.store.projectRelationalNavigationTree.mockClear();

  for (let index = 0; index < 535; index++) view.store.sidebarObjectSearchRevision += 1;

  expect(view.store.projectRelationalNavigationTree).not.toHaveBeenCalled();
  expect(view.store.searchSidebarObjects).not.toHaveBeenCalled();
});

test.each(["opened-tab", "loaded-tree"])("%s scope changes still cancel an active request immediately and search the newly opened database", async (source) => {
  const view = mountSearch();
  const loadedIds = reactive(new Set<string>());
  view.store.isTreeNodeChildrenLoaded.mockImplementation((nodeId: string) => loadedIds.has(nodeId));
  view.store.treeNodes = [
    {
      id: "conn",
      label: "Connection",
      type: "connection",
      connectionId: "conn",
      children: ["app", "other"].map((database) => ({
        id: `conn:${database}`,
        label: database,
        type: "database",
        connectionId: "conn",
        database,
        children: [{ id: `conn:${database}:__procedures`, label: "Procedures", type: "group-procedures", connectionId: "conn", database, children: [] }],
      })),
    },
  ];
  const openDatabase = (database: string) => (source === "opened-tab" ? view.queryStore.openDatabaseKeys.add(sidebarDatabaseOpenKey("conn", database)) : loadedIds.add(`conn:${database}`));
  openDatabase("app");
  view.settingsStore.editorSettings.sidebarSearchOpenedDatabasesOnly = true;
  view.store.searchSidebarObjects.mockImplementationOnce(() => new Promise(() => undefined));
  view.type("routine");
  await vi.advanceTimersByTimeAsync(300);
  const signal = view.store.searchSidebarObjects.mock.calls[0][2];

  openDatabase("other");

  expect(signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(300);
  expect(view.store.searchSidebarObjects.mock.calls.slice(1).map(([node]) => node.database)).toEqual(["app", "other"]);
});

test("component input debounces fallback and cancels the old request immediately before the next debounce", async () => {
  const view = mountSearch();
  let finishOld!: (nodes: TreeNode[]) => void;
  view.store.searchSidebarObjects.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  view.type("o");
  view.type("old");
  await vi.advanceTimersByTimeAsync(300);
  expect(view.store.searchSidebarObjects).toHaveBeenCalledTimes(1);
  const signal = view.store.searchSidebarObjects.mock.calls[0][2];
  view.type("new");
  expect(signal.aborted).toBe(true);
  expect(view.remoteSearchResults.value).toEqual([]);
  expect(view.store.searchSidebarObjects).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(300);
  expect(view.store.searchSidebarObjects.mock.calls[1][1]).toBe("new");
  finishOld([{ id: "old", label: "old", type: "procedure" }]);
  await nextTick();
  await nextTick();
  expect(view.remoteSearchResults.value.flatMap((result) => result.children)).toEqual([]);
  expect(view.toast).not.toHaveBeenCalled();
});

test("keeps the last remote projection visible until the replacement request completes", async () => {
  const view = mountSearch();
  view.store.searchSidebarObjects.mockResolvedValueOnce([{ id: "shared", label: "shared_routine", type: "procedure" }]);
  view.type("shared");
  await vi.advanceTimersByTimeAsync(300);
  await nextTick();
  expect(view.remoteSearchResults.value.flatMap((result) => result.children).map((node) => node.label)).toEqual(["shared_routine"]);

  let finishReplacement!: (nodes: TreeNode[]) => void;
  view.store.searchSidebarObjects.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishReplacement = resolve;
      }),
  );
  view.type("shared_r");
  expect(view.remoteSearchResults.value.flatMap((result) => result.children).map((node) => node.label)).toEqual(["shared_routine"]);
  await vi.advanceTimersByTimeAsync(300);
  expect(view.store.searchSidebarObjects.mock.calls[1][1]).toBe("shared_r");
  expect(view.remoteSearchResults.value.flatMap((result) => result.children).map((node) => node.label)).toEqual(["shared_routine"]);

  finishReplacement([{ id: "replacement", label: "shared_replacement", type: "procedure" }]);
  await vi.advanceTimersByTimeAsync(0);
  await nextTick();
  expect(view.remoteSearchResults.value.flatMap((result) => result.children).map((node) => node.label)).toEqual(["shared_replacement"]);
});

test("retains the last remote projection when its background replacement fails", async () => {
  const view = mountSearch();
  view.store.searchSidebarObjects.mockResolvedValueOnce([{ id: "shared", label: "shared_routine", type: "procedure" }]);
  view.type("shared");
  await vi.advanceTimersByTimeAsync(300);
  await nextTick();
  expect(view.remoteSearchResults.value.flatMap((result) => result.children).map((node) => node.label)).toEqual(["shared_routine"]);

  view.store.searchSidebarObjects.mockRejectedValueOnce(new Error("refresh failed"));
  view.type("shared_r");
  await vi.advanceTimersByTimeAsync(300);
  await nextTick();
  await nextTick();
  expect(view.remoteSearchResults.value.flatMap((result) => result.children).map((node) => node.label)).toEqual(["shared_routine"]);
  expect(view.toast).toHaveBeenCalledOnce();
});

test.each(["local", "regex"])("%s search never dispatches remote object search or discovery", async (mode) => {
  const view = mountSearch();
  if (mode === "local") view.settingsStore.editorSettings.sidebarGlobalSearchLocal = true;
  else view.regexMode.value = true;
  view.type("routine");
  await vi.advanceTimersByTimeAsync(600);
  expect(view.store.searchSidebarObjects).not.toHaveBeenCalled();
  expect(view.store.loadTreeNodeChildren).not.toHaveBeenCalled();
  expect(view.store.loadConnectedConnectionRootForSidebarSearch).not.toHaveBeenCalled();
});

test("searching a connection name does not load unopened databases when none is opened", async () => {
  const view = mountSearch();
  view.settingsStore.editorSettings.sidebarSearchOpenedDatabasesOnly = true;
  view.store.isTreeNodeChildrenLoaded.mockReturnValue(false);
  const databases: TreeNode[] = ["app", "other"].map((database) => ({ id: `conn:${database}`, label: database, type: "database", connectionId: "conn", database, isExpanded: false, children: [] }));
  view.store.treeNodes = [{ id: "conn", label: "north", type: "connection", connectionId: "conn", isExpanded: true, children: databases }];

  view.type("north");
  await vi.advanceTimersByTimeAsync(600);

  expect(view.store.loadTreeNodeChildren).not.toHaveBeenCalled();
  expect(view.store.searchSidebarObjects).not.toHaveBeenCalled();
  expect(databases.every((node) => !node.isExpanded && node.children?.length === 0)).toBe(true);
});

test("searches objects only in databases already opened by the user", async () => {
  const view = mountSearch();
  view.settingsStore.editorSettings.sidebarSearchOpenedDatabasesOnly = true;
  const procedures: TreeNode = { id: "conn:app:__procedures", label: "Procedures", type: "group-procedures", connectionId: "conn", database: "app", children: [] };
  const opened: TreeNode = { id: "conn:app", label: "app", type: "database", connectionId: "conn", database: "app", isExpanded: false, children: [procedures] };
  const unopened: TreeNode = { id: "conn:other", label: "other", type: "database", connectionId: "conn", database: "other", isExpanded: false, children: [] };
  view.store.treeNodes = [{ id: "conn", label: "north", type: "connection", connectionId: "conn", children: [opened, unopened] }];
  view.store.isTreeNodeChildrenLoaded.mockImplementation((nodeId: string) => nodeId !== unopened.id);

  view.type("routine");
  await vi.advanceTimersByTimeAsync(600);

  expect(view.store.searchSidebarObjects).toHaveBeenCalledExactlyOnceWith(procedures, "routine", expect.any(AbortSignal), expect.any(Function));
  expect(view.store.loadTreeNodeChildren).not.toHaveBeenCalled();
});

test.each(["clear", "local", "regex", "disconnect", "refresh", "unmount"])("%s cancels a pending search and ignores its late failure", async (action) => {
  const view = mountSearch();
  let fail!: (error: Error) => void;
  view.store.searchSidebarObjects.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  view.type("routine");
  await vi.advanceTimersByTimeAsync(300);
  const signal = view.store.searchSidebarObjects.mock.calls[0][2];
  if (action === "clear") view.type("");
  if (action === "local") view.settingsStore.editorSettings.sidebarGlobalSearchLocal = true;
  if (action === "regex") view.regexMode.value = true;
  if (action === "disconnect") view.store.connectedIds.clear();
  if (action === "refresh") view.store.sidebarObjectSearchRevision += 1;
  if (action === "unmount") {
    view.app.unmount();
    cleanups.pop();
  }
  expect(signal.aborted).toBe(true);
  fail(new Error("cancelled"));
  await nextTick();
  await nextTick();
  expect(view.toast).not.toHaveBeenCalled();
  expect(view.remoteSearchResults.value).toEqual([]);
});
