import { expect, test, vi } from "vitest";
import { collectSidebarGlobalSearchIndexes, sidebarIndexedObjectGroupTypes, type SidebarGlobalSearchIndexLoader } from "../../apps/desktop/src/lib/sidebar/sidebarGlobalSearchIndex.ts";
import type { SidebarRegexIndexScope } from "../../apps/desktop/src/lib/sidebar/sidebarSearchTree.ts";
import { resolveSidebarSearchDatabaseScope } from "../../apps/desktop/src/lib/sidebar/sidebarSearchDatabaseScope.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";

function fixture() {
  const tables: TreeNode = { id: "conn:app:public:tables", type: "group-tables", label: "Tables", connectionId: "conn", database: "app", schema: "public", children: [], isExpanded: false };
  const schema: TreeNode = { id: "conn:app:public", type: "schema", label: "public", connectionId: "conn", database: "app", schema: "public", children: [tables], isExpanded: false };
  const database: TreeNode = { id: "conn:app", type: "database", label: "app", connectionId: "conn", database: "app", children: [schema], isExpanded: false };
  const root: TreeNode = { id: "conn", type: "connection", label: "Connection", connectionId: "conn", children: [database], isExpanded: false };
  const cached: SidebarRegexIndexScope = { parentNodeId: tables.id, connectionId: "conn", database: "app", schema: "public", nodeType: "group-tables", path: [root, database, schema, tables].map(({ children: _children, ...node }) => node), entries: [{ name: "late_table", table_type: "TABLE" }] };
  const loader = {
    loadCachedScopes: vi.fn(async () => [] as SidebarRegexIndexScope[]),
    isIndexParent: (node: TreeNode) => sidebarIndexedObjectGroupTypes.has(node.type),
    discover: vi.fn(async (node: TreeNode) => node.children ?? []),
    loadIndex: vi.fn(async () => cached.entries),
    onError: vi.fn(),
  } satisfies SidebarGlobalSearchIndexLoader;
  const run = (databaseScope: ReadonlySet<string> | null = null, shouldCancel = () => false) => collectSidebarGlobalSearchIndexes(loader, [root], "conn", databaseScope, shouldCancel);
  return { root, database, schema, tables, cached, loader, run };
}

test("builds a complete index once per leaf scope without loading table children", async () => {
  const { root, tables, loader, run } = fixture();
  const before = structuredClone(root);
  const results = await run();
  expect(results[0].entries[0].name).toBe("late_table");
  expect(loader.loadIndex).toHaveBeenCalledExactlyOnceWith(tables);
  expect(loader.discover).not.toHaveBeenCalledWith(tables);
  expect(root).toEqual(before);
});

test("uses persisted scopes when a collapsed branch is absent from the live tree", async () => {
  const { root, cached, loader, run } = fixture();
  root.children = [];
  loader.loadCachedScopes.mockResolvedValue([cached]);
  const results = await run();
  expect(results[0].entries).toEqual(cached.entries);
  expect(loader.loadIndex).not.toHaveBeenCalled();
  expect(root.children).toEqual([]);
});

test("publishes a cached scope first and replaces it after background revalidation", async () => {
  const { cached, loader, run, tables } = fixture();
  const cachedFirst = { ...cached, stale: false, entries: [{ name: "Photos", table_type: "TABLE" }] };
  const refreshed = [
    { name: "Photos", table_type: "TABLE" },
    { name: "Photos_Gallery", table_type: "TABLE" },
  ];
  loader.loadCachedScopes.mockResolvedValue([cachedFirst]);
  loader.loadIndex.mockResolvedValue(refreshed);
  const progress: SidebarRegexIndexScope[][] = [];

  const results = await collectSidebarGlobalSearchIndexes(
    loader,
    [
      {
        id: "conn",
        type: "connection",
        label: "Connection",
        connectionId: "conn",
        children: [{ id: "conn:app", type: "database", label: "app", connectionId: "conn", database: "app", children: [{ id: "conn:app:public", type: "schema", label: "public", connectionId: "conn", database: "app", schema: "public", children: [tables] }] }],
      },
    ],
    "conn",
    null,
    () => false,
    (scopes) => progress.push(scopes),
  );

  expect(progress[0][0].entries.map((entry) => entry.name)).toEqual(["Photos"]);
  expect(loader.loadIndex).toHaveBeenCalledExactlyOnceWith(tables, { refresh: true });
  expect(results[0].entries.map((entry) => entry.name)).toEqual(["Photos", "Photos_Gallery"]);
  expect(progress.at(-1)?.[0].entries.map((entry) => entry.name)).toEqual(["Photos", "Photos_Gallery"]);
});

test("retains a cached scope when background revalidation fails", async () => {
  const { cached, loader, run } = fixture();
  const cachedFirst = { ...cached, stale: false, entries: [{ name: "Photos", table_type: "TABLE" }] };
  loader.loadCachedScopes.mockResolvedValue([cachedFirst]);
  loader.loadIndex.mockRejectedValue(new Error("offline"));

  const results = await run();

  expect(results).toEqual([cachedFirst]);
  expect(loader.onError).toHaveBeenCalledOnce();
});

test("restricts cached and missing scopes to opened databases", async () => {
  const { root, database, cached, loader, run } = fixture();
  root.children?.push({ ...database, id: "conn:other", database: "other", children: [] });
  loader.loadCachedScopes.mockResolvedValue([cached]);
  const results = await run(new Set(["conn:other"]));
  expect(results).toEqual([]);
  expect(loader.discover).not.toHaveBeenCalledWith(database);
  expect(loader.loadIndex).not.toHaveBeenCalled();
});

test("does not discover or index unopened databases when none has been opened", async () => {
  const { root, database, cached, loader, run } = fixture();
  root.children?.push({ ...database, id: "conn:other", database: "other", children: [] });
  loader.loadCachedScopes.mockResolvedValue([cached]);
  const scope = resolveSidebarSearchDatabaseScope(root, { enabled: true, isChildrenLoaded: () => false, openDatabaseKeys: new Set() });

  expect(await run(scope)).toEqual([]);
  expect(loader.discover).toHaveBeenCalledExactlyOnceWith(root);
  expect(loader.loadIndex).not.toHaveBeenCalled();
  expect(root.children?.every((node) => !node.isExpanded)).toBe(true);
});

test("discovers a missing namespace before indexing its tables", async () => {
  const { database, schema, tables, loader, run } = fixture();
  database.children = [];
  loader.discover.mockImplementation(async (node) => (node === database ? [schema] : (node.children ?? [])));
  const results = await run();
  expect(loader.loadIndex).toHaveBeenCalledExactlyOnceWith(tables);
  expect(results[0].path?.map((node) => node.id)).toEqual(["conn", "conn:app", "conn:app:public", tables.id]);
});

test("does not index a different connection", async () => {
  const { root, database, loader } = fixture();
  const other: TreeNode = { ...root, id: "other", connectionId: "other", children: [{ ...database, connectionId: "other" }] };
  await collectSidebarGlobalSearchIndexes(loader, [other], "conn", null, () => false);
  expect(loader.loadIndex).not.toHaveBeenCalled();
  expect(loader.discover).not.toHaveBeenCalled();
});

test("keeps successful scopes when another schema fails", async () => {
  const { schema, tables, loader, run } = fixture();
  const views: TreeNode = { ...tables, id: "conn:app:public:views", type: "group-views" };
  schema.children?.push(views);
  loader.loadIndex.mockRejectedValueOnce(new Error("access denied"));
  const results = await run();
  expect(loader.onError).toHaveBeenCalledTimes(1);
  expect(results.map((scope) => scope.parentNodeId)).toEqual([views.id]);
});

test("stops discovery and discards results when disconnected during a build", async () => {
  const { schema, tables, loader, run } = fixture();
  schema.children?.push({ ...tables, id: "views", type: "group-views" });
  let cancelled = false;
  loader.loadIndex.mockImplementation(async () => {
    cancelled = true;
    return [];
  });
  expect(await run(null, () => cancelled)).toEqual([]);
  expect(loader.loadIndex).toHaveBeenCalledTimes(1);
});
