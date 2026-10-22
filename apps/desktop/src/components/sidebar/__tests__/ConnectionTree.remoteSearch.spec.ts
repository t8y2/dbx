// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import ts from "typescript";
import { parse } from "vue/compiler-sfc";
import { computed, createApp, defineComponent, h, nextTick, reactive, ref } from "vue";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useSidebarRemoteSearch } from "@/composables/useSidebarRemoteSearch";
import { collectSidebarRemoteSearchResults, type SidebarRemoteSearchResult } from "@/lib/sidebar/sidebarRemoteSearch";
import { findNodePathByIdentity } from "@/lib/sidebar/sidebarSearchTree";
import { sidebarIndexedObjectGroupTypes } from "@/lib/sidebar/sidebarGlobalSearchIndex";
import { resolveSidebarSearchDatabaseScope } from "@/lib/sidebar/sidebarSearchDatabaseScope";
import type { TreeNode } from "@/types/database";

const source = parse(readFileSync("apps/desktop/src/components/sidebar/ConnectionTree.vue", "utf8")).descriptor.scriptSetup!.content;
const script = ts.createSourceFile("ConnectionTree.ts", source, ts.ScriptTarget.Latest, true);
const statements = script.statements.filter((statement) => {
  if (ts.isFunctionDeclaration(statement)) return ["loadGlobalRemoteSearchResults", "isGlobalTableIndexParent", "discoverGlobalSearchChildren"].includes(statement.name?.text ?? "");
  return ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => ["globalSearchContext", "{ results: remoteSearchResults, isLoading: isRemoteSearchLoading }"].includes(declaration.name.getText(script)));
});
const compiled = ts.transpileModule(statements.map((statement) => statement.getText(script)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
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
    activeConnectionId: "conn",
    connectedIds: new Set(["conn"]),
    treeNodes: [root],
    sidebarTableSearchIndexInvalidation: { revision: 0 },
    sidebarObjectSearchRevision: 0,
    isTreeNodeChildrenLoaded: vi.fn(() => true),
    searchSidebarObjects: vi.fn(async (_node: TreeNode, _query: string, _signal: AbortSignal): Promise<TreeNode[]> => []),
    loadTreeNodeChildren: vi.fn(),
    loadConnectedConnectionRootForSidebarSearch: vi.fn(),
  });
  const toast = vi.fn();
  const bindings = {
    ref,
    computed,
    searchQuery,
    regexMode,
    settingsStore,
    store,
    toast,
    queryStore: { openDatabaseKeys: new Set() },
    selectedSearchScopes: ref([]),
    searchableNodeTypes: ref(undefined),
    useSidebarRemoteSearch,
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
  return { ...state, store, settingsStore, regexMode, toast, type, app };
}

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
