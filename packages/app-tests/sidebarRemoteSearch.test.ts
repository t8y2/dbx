import { expect, test, vi } from "vitest";
import { collectSidebarRemoteSearchResults, mergeSidebarRemoteSearchResults } from "../../apps/desktop/src/lib/sidebar/sidebarRemoteSearch";
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
