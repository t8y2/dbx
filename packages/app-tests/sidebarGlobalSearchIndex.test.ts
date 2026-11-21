import { expect, test, vi } from "vitest";
import { collectSidebarGlobalSearchIndexes, sidebarIndexedObjectGroupTypes, type SidebarGlobalSearchIndexLoader } from "../../apps/desktop/src/lib/sidebar/sidebarGlobalSearchIndex.ts";
import { mergeSidebarRegexIndexScopes, type SidebarRegexIndexScope } from "../../apps/desktop/src/lib/sidebar/sidebarSearchTree.ts";
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

test("indexes databases inside nested collapsed virtual folders", async () => {
  const { root, database, tables, loader, run } = fixture();
  const folder = (id: string, children: TreeNode[]): TreeNode => ({ id, type: "table-vgroup", label: id, vgroupKind: "databases", connectionId: "conn", isExpanded: false, children });
  root.children = [folder("outer", [folder("inner", [database])])];
  const result = await run();
  expect(loader.loadIndex).toHaveBeenCalledExactlyOnceWith(tables);
  expect(result[0].entries[0].name).toBe("late_table");
  // Index paths contain metadata identities, not disposable UI folder identities.
  expect(result[0].path?.some((node) => node.type === "table-vgroup")).toBe(false);
  loader.loadIndex.mockClear();
  await run(new Set(["conn:other"]));
  expect(loader.loadIndex).not.toHaveBeenCalled();
});

test.each([false, true])("anchors old index paths to grouped live databases (unloaded descendants: %s)", (unloaded) => {
  const { root, database, cached } = fixture();
  if (unloaded) database.children = [];
  root.children = [{ id: "folder", type: "table-vgroup", label: "Business", vgroupKind: "databases", connectionId: "conn", children: [database] }];
  const before = structuredClone(root);
  const merged = mergeSidebarRegexIndexScopes([root], [cached]);
  expect(merged[0].children?.map((node) => node.id)).toEqual(["folder"]);
  expect(merged[0].children?.[0].children?.[0].children?.[0].children?.[0].children?.[0].label).toBe("late_table");
  expect(root).toEqual(before);
});

test.each(["hidden", "deleted", "moved"])("ignores stale virtual folder paths after a group is %s", (state) => {
  const { root, database, cached } = fixture();
  cached.path!.splice(1, 0, { id: "old-folder", type: "table-vgroup", label: "Old", connectionId: "conn" });
  database.children = [];
  if (state === "moved") root.children = [{ id: "new-folder", type: "table-vgroup", label: "New", vgroupKind: "databases", connectionId: "conn", children: [database] }];
  const merged = mergeSidebarRegexIndexScopes([root], [cached]);
  expect(merged[0].children?.map((node) => node.id)).toEqual([state === "moved" ? "new-folder" : database.id]);
  const db = state === "moved" ? merged[0].children![0].children![0] : merged[0].children![0];
  expect(db.children?.[0].children?.[0].children?.[0].label).toBe("late_table");
});

test("anchors same-named database indexes only to their matching catalog", () => {
  const { root, database, cached } = fixture();
  const databaseA: TreeNode = { ...database, id: "shared-db-id", catalog: "a", children: [] };
  const databaseB: TreeNode = { ...database, id: "shared-db-id", catalog: "b", children: [] };
  const catalogA: TreeNode = { id: "catalog-a", type: "doris-catalog", label: "A", connectionId: "conn", catalog: "a", children: [databaseA] };
  const catalogB: TreeNode = { id: "catalog-b", type: "doris-catalog", label: "B", connectionId: "conn", catalog: "b", children: [{ id: "folder-b", type: "table-vgroup", label: "B group", vgroupKind: "databases", connectionId: "conn", catalog: "b", children: [databaseB] }] };
  root.children = [catalogA, catalogB];
  const scope: SidebarRegexIndexScope = { ...cached, catalog: "b", parentNodeId: "b-tables", path: [root, catalogB, databaseB, { id: "b-tables", type: "group-tables", label: "Tables", connectionId: "conn", database: "app", catalog: "b", schema: "public" }] };
  const merged = mergeSidebarRegexIndexScopes([root], [scope]);
  expect(merged[0].children![0].children![0].children).toEqual([]);
  const groupedB = merged[0].children![1].children![0];
  expect(groupedB.id).toBe("folder-b");
  expect(groupedB.children![0].children![0].children![0].label).toBe("late_table");
});

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
