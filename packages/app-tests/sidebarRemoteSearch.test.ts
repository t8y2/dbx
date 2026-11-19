import { expect, test, vi } from "vitest";
import { effectScope, ref } from "vue";
import { useSidebarRemoteSearch } from "../../apps/desktop/src/composables/useSidebarRemoteSearch";
import { collectSidebarRemoteSearchResults, mergeSidebarRemoteSearchResults, removeVerifiedSidebarTriggerSearchResult } from "../../apps/desktop/src/lib/sidebar/sidebarRemoteSearch";
import type { TreeNode, TreeNodeType } from "../../apps/desktop/src/types/database";

const remoteObjectGroupTypes = [
  "group-procedures",
  "group-functions",
  "group-internal-functions",
  "group-udf-functions",
  "group-triggers",
  "group-events",
  "group-sequences",
  "group-database-indexes",
  "group-synonyms",
  "group-jobs",
  "group-packages",
  "group-types",
] as const satisfies readonly TreeNodeType[];

const indexedObjectGroupTypes = ["group-tables", "group-dolt-system-tables", "group-views", "group-materialized-views"] as const satisfies readonly TreeNodeType[];

function fixture() {
  const identity = { connectionId: "conn", database: "app", schema: "public" };
  const procedures: TreeNode = { ...identity, id: "conn:app:public:__procedures", type: "group-procedures", label: "Procedures", children: [], isExpanded: false };
  const functions: TreeNode = { ...identity, id: "conn:app:public:__functions", type: "group-functions", label: "Functions", children: [], isExpanded: false };
  const tables: TreeNode = { ...identity, id: "conn:app:public:__tables", type: "group-tables", label: "Tables", children: [] };
  const schema: TreeNode = { ...identity, id: "conn:app:public", type: "schema", label: "public", children: [tables, procedures, functions], isExpanded: false };
  const root: TreeNode = { connectionId: "conn", id: "conn", type: "connection", label: "Connection", children: [schema] };
  const controller = new AbortController();
  const search = vi.fn(async (node: TreeNode): Promise<TreeNode[]> => [{ ...identity, id: `${node.id}:late_routine`, type: node === procedures ? "procedure" : "function", label: "late_routine" }]);
  const options = { root, connectionId: "conn", databaseScope: null as ReadonlySet<string> | null, signal: controller.signal, isSimpleParent: (_node: TreeNode) => false, discover: vi.fn(async (node: TreeNode) => node.children ?? []), search, onError: vi.fn() };
  return { root, schema, procedures, functions, tables, controller, options };
}

test("removes only the verified physical trigger from search projections", () => {
  const trigger = (name: string, objectId: string, catalog = "catalog-a", connectionId = "conn"): TreeNode => ({
    id: name,
    label: name,
    objectName: name,
    type: "trigger",
    connectionId,
    database: "service",
    schema: " Owner ",
    catalog,
    meta: { name, timing: "BEFORE", event: "INSERT", oracle_metadata: { contractVersion: 1, identityMode: "exact", engine: "oracle", owner: " Owner ", name, objectId } },
  });
  const removed = trigger(" Raw Trigger ", "old-id");
  const retained = [trigger(" Raw Trigger ", "replacement-id"), trigger(" raw trigger ", "neighbor-id"), trigger(" Raw Trigger ", "old-id", "catalog-b"), trigger(" Raw Trigger ", "old-id", "catalog-a", "other")];
  const results = [{ parentNodeId: "group", nodeType: "group-triggers" as const, connectionId: "conn", database: "service", children: [removed, ...retained] }];
  const next = removeVerifiedSidebarTriggerSearchResult(results, removed);
  expect(next[0].children).toEqual(retained);
  expect(results[0].children).toHaveLength(5);
  expect(removeVerifiedSidebarTriggerSearchResult(results, { ...removed, meta: undefined })[0].children).toHaveLength(5);
});

test("a late search response cannot resurrect a verified deleted trigger", async () => {
  vi.useFakeTimers();
  const scope = effectScope();
  try {
    const node: TreeNode = {
      id: "trigger",
      label: "trigger",
      objectName: "trigger",
      type: "trigger",
      connectionId: "conn",
      database: "service",
      schema: "owner",
      meta: { name: "trigger", timing: "BEFORE", event: "INSERT", oracle_metadata: { contractVersion: 1, identityMode: "exact", engine: "oracle", owner: "owner", name: "trigger", objectId: "old-id" } },
    };
    const oldResult = [{ parentNodeId: "group", nodeType: "group-triggers" as const, connectionId: "conn", database: "service", schema: "owner", children: [node] }];
    let finish!: (result: typeof oldResult) => void;
    let publish!: (result: typeof oldResult) => void;
    let oldSignal!: AbortSignal;
    let calls = 0;
    const query = ref("");
    const remote = scope.run(() =>
      useSidebarRemoteSearch({
        query,
        enabled: ref(true),
        context: [],
        onError: (error) => {
          throw error;
        },
        load: async (_query, signal, onProgress) => {
          if (calls++ > 0) return [{ ...oldResult[0], children: [] }];
          oldSignal = signal;
          publish = onProgress;
          onProgress(oldResult);
          return new Promise<typeof oldResult>((resolve) => {
            finish = resolve;
          });
        },
      }),
    )!;
    query.value = "trigger";
    await vi.advanceTimersByTimeAsync(300);
    expect(remote.results.value[0].children).toEqual([node]);
    remote.removeVerifiedTriggerNode(node);
    expect(remote.results.value[0].children).toEqual([]);
    publish(oldResult);
    finish(oldResult);
    await vi.advanceTimersByTimeAsync(0);
    expect(remote.results.value[0].children).toEqual([]);
    expect(oldSignal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(remote.results.value[0].children).toEqual([]);
  } finally {
    scope.stop();
    vi.useRealTimers();
  }
});

test("searches never-expanded procedure/function groups, not indexed table/view groups", async () => {
  const { root, procedures, functions, tables, options } = fixture();
  const before = structuredClone(root);
  const results = await collectSidebarRemoteSearchResults(options);
  expect(options.search.mock.calls.map(([node]) => node)).toEqual([procedures, functions]);
  expect(options.search).not.toHaveBeenCalledWith(tables);
  const projected = mergeSidebarRemoteSearchResults([root], results);
  expect(projected[0].children?.[0].children?.[1].children?.[0].label).toBe("late_routine");
  expect(projected[0].children?.[0].children?.[2].children?.[0].type).toBe("function");
  expect(root).toEqual(before);
});

test.each(remoteObjectGroupTypes)("searches an unexpanded %s group through the stable remote projection", async (type) => {
  const identity = { connectionId: "conn", database: "app", schema: "public" };
  const group: TreeNode = { ...identity, id: `conn:app:public:${type}`, type, label: type, children: [], isExpanded: false };
  const root: TreeNode = { connectionId: "conn", id: "conn", type: "connection", label: "Connection", children: [group] };
  const search = vi.fn(async (): Promise<TreeNode[]> => [{ ...identity, id: `${group.id}:match`, type: "procedure", label: "match" }]);
  const results = await collectSidebarRemoteSearchResults({
    root,
    connectionId: "conn",
    databaseScope: null,
    signal: new AbortController().signal,
    isSimpleParent: () => false,
    discover: vi.fn(async (node: TreeNode) => node.children ?? []),
    search,
    onError: vi.fn(),
  });
  expect(search).toHaveBeenCalledExactlyOnceWith(group, expect.any(Function));
  expect(results).toHaveLength(1);
});

test.each(indexedObjectGroupTypes)("leaves %s on the local-index path", async (type) => {
  const group: TreeNode = { connectionId: "conn", database: "app", schema: "public", id: `conn:app:public:${type}`, type, label: type, children: [], isExpanded: false };
  const search = vi.fn(async (): Promise<TreeNode[]> => []);
  const results = await collectSidebarRemoteSearchResults({
    root: { connectionId: "conn", id: "conn", type: "connection", label: "Connection", children: [group] },
    connectionId: "conn",
    databaseScope: null,
    signal: new AbortController().signal,
    isSimpleParent: () => false,
    discover: vi.fn(async (node: TreeNode) => node.children ?? []),
    search,
    onError: vi.fn(),
  });
  expect(search).not.toHaveBeenCalled();
  expect(results).toEqual([]);
});

test("discovers missing groups rather than searching only the first loaded page", async () => {
  const { schema, procedures, functions, options } = fixture();
  schema.children = [];
  options.discover.mockImplementation(async (node) => (node === schema ? [procedures, functions] : (node.children ?? [])));
  expect(await collectSidebarRemoteSearchResults(options)).toHaveLength(2);
});

test("stops dispatching further scopes and ignores responses after cancellation", async () => {
  const { controller, options } = fixture();
  options.search.mockImplementation(async () => {
    controller.abort();
    return [];
  });
  expect(await collectSidebarRemoteSearchResults(options)).toEqual([]);
  expect(options.search).toHaveBeenCalledTimes(1);
});

test("keeps successful results when another object group fails", async () => {
  const { functions, options } = fixture();
  options.search.mockRejectedValueOnce(new Error("denied"));
  const results = await collectSidebarRemoteSearchResults(options);
  expect(results.map((result) => result.parentNodeId)).toEqual([functions.id]);
  expect(options.onError).toHaveBeenCalledOnce();
});

test("honors opened-database scope and connection identity", async () => {
  const { root, schema, options } = fixture();
  root.children = [{ id: "conn:app", type: "database", label: "app", database: "app", connectionId: "conn", children: [schema] }];
  options.databaseScope = new Set(["conn:other"]);
  await collectSidebarRemoteSearchResults(options);
  expect(options.search).not.toHaveBeenCalled();
  options.databaseScope = null;
  schema.connectionId = "different";
  await collectSidebarRemoteSearchResults(options);
  expect(options.search).not.toHaveBeenCalled();
});

test("searches a simple-display parent without expanding its table list", async () => {
  const { schema, options } = fixture();
  options.isSimpleParent = (node: TreeNode) => node === schema;
  const results = await collectSidebarRemoteSearchResults(options);
  expect(results.map((result) => result.parentNodeId)).toEqual([schema.id]);
  expect(options.discover).not.toHaveBeenCalledWith(schema);
});

test("merges into the correct catalog and preserves live child state", async () => {
  const { root, schema, procedures, options } = fixture();
  const live: TreeNode = { id: `${procedures.id}:late_routine`, type: "procedure", label: "late_routine", isExpanded: true };
  procedures.children = [live];
  root.children?.push({ ...schema, catalog: "other", children: [{ ...procedures, catalog: "other", children: [] }] });
  const projected = mergeSidebarRemoteSearchResults([root], await collectSidebarRemoteSearchResults({ ...options, root: { ...root, children: [schema] } }));
  expect(projected[0].children?.[0].children?.[1].children).toEqual([live]);
  expect(projected[0].children?.[1].children?.[0].children).toEqual([]);
});
