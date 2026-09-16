import { strict as assert } from "node:assert";
import { test, vi } from "vitest";
import { collectSidebarRegexIndexScopes, regexTableSearchParents, resolveSidebarRemoteSearchQuery, resolveSidebarSearchDispatchMode } from "../../apps/desktop/src/lib/sidebar/sidebarRegexSearchIndex.ts";
import type { SidebarRegexIndexScope } from "../../apps/desktop/src/lib/sidebar/sidebarSearchTree.ts";
import type { TableInfo, TreeNode } from "../../apps/desktop/src/types/database.ts";

function table(name: string, table_type = "TABLE"): TableInfo {
  return { name, table_type };
}

function scope(parentNodeId: string, overrides: Partial<SidebarRegexIndexScope> = {}): SidebarRegexIndexScope {
  return {
    parentNodeId,
    connectionId: "conn-1",
    database: "app",
    schema: "public",
    nodeType: "group-tables",
    entries: [],
    ...overrides,
  };
}

test("regex mode always dispatches to the local index read regardless of the local search setting", () => {
  assert.equal(resolveSidebarSearchDispatchMode({ query: "A|b", regexMode: true, wasRegexMode: false }, { localSearchEnabled: true }), "regex");
  assert.equal(resolveSidebarSearchDispatchMode({ query: "A|b", regexMode: true, wasRegexMode: false }, { localSearchEnabled: false }), "regex");
  // Editing and clearing the expression while regex stays on keep the same branch.
  assert.equal(resolveSidebarSearchDispatchMode({ query: "A|b|c", regexMode: true, wasRegexMode: true }, { localSearchEnabled: false }), "regex");
  assert.equal(resolveSidebarSearchDispatchMode({ query: "", regexMode: true, wasRegexMode: true }, { localSearchEnabled: true }), "regex");
});

test("leaving regex mode restores the configured ordinary search behavior", () => {
  assert.equal(resolveSidebarSearchDispatchMode({ query: "orders", regexMode: false, wasRegexMode: true }, { localSearchEnabled: false }), "ordinary");
  assert.equal(resolveSidebarSearchDispatchMode({ query: "orders", regexMode: false, wasRegexMode: true }, { localSearchEnabled: true }), "none");
  assert.equal(resolveSidebarSearchDispatchMode({ query: "", regexMode: false, wasRegexMode: true }, { localSearchEnabled: false }), "none");
});

test("local search on keeps ordinary queries local and local search off enables the remote refresh", () => {
  assert.equal(resolveSidebarSearchDispatchMode({ query: "orders", regexMode: false, wasRegexMode: false }, { localSearchEnabled: true }), "none");
  assert.equal(resolveSidebarSearchDispatchMode({ query: "orders", regexMode: false, wasRegexMode: false }, { localSearchEnabled: false }), "ordinary");
  assert.equal(resolveSidebarSearchDispatchMode({ query: "", regexMode: false, wasRegexMode: false }, { localSearchEnabled: false }), "ordinary");
});

test("collects manifest scopes and live-tree backfill scopes through the read-only reader", async () => {
  const manifestScope = scope("conn-1:app:public:__tables", { path: [{ id: "conn-1", label: "c", type: "connection", connectionId: "conn-1" }] });
  const live: TreeNode[] = [
    {
      id: "conn-1",
      label: "c",
      type: "connection",
      connectionId: "conn-1",
      children: [
        {
          id: "conn-1:app",
          label: "app",
          type: "database",
          connectionId: "conn-1",
          database: "app",
          children: [
            {
              id: "conn-1:app:legacy",
              label: "legacy",
              type: "schema",
              connectionId: "conn-1",
              database: "app",
              schema: "legacy",
            },
          ],
        },
      ],
    },
  ];
  const loadSidebarTableSearchIndex = vi.fn(async (parent: { parentNodeId: string }) => (parent.parentNodeId === "conn-1:app:legacy" ? [table("legacy_table")] : null));
  const reader = {
    loadSidebarTableSearchIndexScopes: vi.fn(async () => [{ scope: manifestScope, entries: [table("manifest_table")] }]),
    loadSidebarTableSearchIndex,
  };

  const result = await collectSidebarRegexIndexScopes(reader, live, () => false);

  assert.deepEqual(
    result.map(({ parentNodeId }) => parentNodeId),
    ["conn-1:app:public:__tables", "conn-1:app:legacy"],
  );
  // Manifest scopes keep their recorded path...
  assert.deepEqual(result[0]?.path, manifestScope.path);
  assert.deepEqual(result[0]?.entries, [table("manifest_table")]);
  // ...while the legacy backfill scope deliberately has no path so the merge
  // layer anchors it to the live parent instead of guessing ancestors.
  assert.equal(result[1]?.path, undefined);
  assert.equal(result[1]?.nodeType, "schema");
  assert.deepEqual(result[1]?.entries, [table("legacy_table")]);
  assert.equal(reader.loadSidebarTableSearchIndexScopes.mock.calls.length, 1);
  // Every live regex parent is probed for a pre-manifest index, each by its
  // composite identity (id plus database context), never by the bare id.
  assert.deepEqual(
    loadSidebarTableSearchIndex.mock.calls.map(([parent]) => parent.parentNodeId),
    ["conn-1:app", "conn-1:app:legacy"],
  );
  assert.deepEqual(loadSidebarTableSearchIndex.mock.calls[0]?.[0], {
    parentNodeId: "conn-1:app",
    connectionId: "conn-1",
    database: "app",
    schema: undefined,
    catalog: undefined,
    nodeType: "database",
  });
  assert.deepEqual(loadSidebarTableSearchIndex.mock.calls[1]?.[0], {
    parentNodeId: "conn-1:app:legacy",
    connectionId: "conn-1",
    database: "app",
    schema: "legacy",
    catalog: undefined,
    nodeType: "schema",
  });
});

test("skips live-tree parents that already have a manifest scope", async () => {
  const manifestScope = scope("conn-1:app:public", { nodeType: "schema" });
  const live: TreeNode[] = [{ id: "conn-1:app:public", label: "public", type: "schema", connectionId: "conn-1", database: "app", schema: "public" }];
  const loadSidebarTableSearchIndex = vi.fn(async () => null);
  const reader = {
    loadSidebarTableSearchIndexScopes: vi.fn(async () => [{ scope: manifestScope, entries: [table("manifest_table")] }]),
    loadSidebarTableSearchIndex,
  };

  const result = await collectSidebarRegexIndexScopes(reader, live, () => false);

  assert.deepEqual(
    result.map(({ parentNodeId }) => parentNodeId),
    ["conn-1:app:public"],
  );
  assert.equal(loadSidebarTableSearchIndex.mock.calls.length, 0);
});

test("collects every legacy scope when legal tree nodes share an id", async () => {
  const sharedId = "conn-1:a:b";
  const live: TreeNode[] = [
    {
      id: "conn-1",
      label: "c",
      type: "connection",
      connectionId: "conn-1",
      children: [
        { id: sharedId, label: "a:b", type: "database", connectionId: "conn-1", database: "a:b" },
        {
          id: "conn-1:a",
          label: "a",
          type: "database",
          connectionId: "conn-1",
          database: "a",
          children: [{ id: sharedId, label: "b", type: "schema", connectionId: "conn-1", database: "a", schema: "b" }],
        },
      ],
    },
  ];
  const loadSidebarTableSearchIndex = vi.fn(async (parent: { database: string; schema?: string }) => (parent.database === "a" && parent.schema === "b" ? [table("schema_table")] : null));
  const reader = {
    loadSidebarTableSearchIndexScopes: vi.fn(async () => []),
    loadSidebarTableSearchIndex,
  };

  const result = await collectSidebarRegexIndexScopes(reader, live, () => false);

  assert.deepEqual(
    result.map(({ database, schema }) => [database, schema]),
    [["a", "b"]],
  );
  assert.deepEqual(
    loadSidebarTableSearchIndex.mock.calls.filter(([parent]) => parent.parentNodeId === sharedId).map(([parent]) => [parent.database, parent.schema]),
    [
      ["a:b", undefined],
      ["a", "b"],
    ],
  );
});

test("a manifest scope suppresses only the matching live identity", async () => {
  const sharedId = "conn-1:a:b";
  const manifestScope = scope(sharedId, { database: "a:b", schema: undefined, nodeType: "database" });
  const live: TreeNode[] = [
    {
      id: "conn-1",
      label: "c",
      type: "connection",
      connectionId: "conn-1",
      children: [
        { id: sharedId, label: "a:b", type: "database", connectionId: "conn-1", database: "a:b" },
        {
          id: "conn-1:a",
          label: "a",
          type: "database",
          connectionId: "conn-1",
          database: "a",
          children: [{ id: sharedId, label: "b", type: "schema", connectionId: "conn-1", database: "a", schema: "b" }],
        },
      ],
    },
  ];
  const loadSidebarTableSearchIndex = vi.fn(async (parent: { database: string; schema?: string }) => (parent.database === "a" && parent.schema === "b" ? [table("schema_table")] : null));
  const reader = {
    loadSidebarTableSearchIndexScopes: vi.fn(async () => [{ scope: manifestScope, entries: [table("database_table")] }]),
    loadSidebarTableSearchIndex,
  };

  const result = await collectSidebarRegexIndexScopes(reader, live, () => false);

  assert.deepEqual(
    result.map(({ database, schema }) => [database, schema]),
    [
      ["a:b", undefined],
      ["a", "b"],
    ],
  );
  assert.deepEqual(
    loadSidebarTableSearchIndex.mock.calls.filter(([parent]) => parent.parentNodeId === sharedId).map(([parent]) => [parent.database, parent.schema]),
    [["a", "b"]],
  );
});

test("stops collecting when the search is cancelled mid-run", async () => {
  let cancelled = false;
  const live: TreeNode[] = [
    {
      id: "conn-1",
      label: "c",
      type: "connection",
      connectionId: "conn-1",
      children: [
        {
          id: "conn-1:app",
          label: "app",
          type: "database",
          connectionId: "conn-1",
          database: "app",
          children: [
            { id: "conn-1:app:s1", label: "s1", type: "schema", connectionId: "conn-1", database: "app", schema: "s1" },
            { id: "conn-1:app:s2", label: "s2", type: "schema", connectionId: "conn-1", database: "app", schema: "s2" },
          ],
        },
      ],
    },
  ];
  const loadSidebarTableSearchIndex = vi.fn(async () => {
    cancelled = true;
    return [table("s1_table")];
  });
  const reader = {
    loadSidebarTableSearchIndexScopes: vi.fn(async () => []),
    loadSidebarTableSearchIndex,
  };

  const result = await collectSidebarRegexIndexScopes(reader, live, () => cancelled);

  // The scope already collected for the first parent is kept (the component
  // discards the whole run when the mode changed), but no further parent is
  // probed once the search is cancelled.
  assert.deepEqual(
    result.map(({ parentNodeId }) => parentNodeId),
    ["conn-1:app"],
  );
  assert.deepEqual(
    loadSidebarTableSearchIndex.mock.calls.map(([parent]) => parent.parentNodeId),
    ["conn-1:app"],
  );
});

test("regex mode keeps the remote tree-loading search query empty", () => {
  assert.equal(resolveSidebarRemoteSearchQuery(true, "A|b"), "");
  assert.equal(resolveSidebarRemoteSearchQuery(true, ""), "");
  // Ordinary search keeps using the query for remote loading.
  assert.equal(resolveSidebarRemoteSearchQuery(false, "A|b"), "A|b");
  assert.equal(resolveSidebarRemoteSearchQuery(false, ""), "");
});

test("regexTableSearchParents walks grouped and nested tree shapes in order", () => {
  const groupTables: TreeNode = { id: "conn-1:app:public:__tables", label: "Tables", type: "group-tables", connectionId: "conn-1", database: "app", schema: "public" };
  const live: TreeNode[] = [
    {
      id: "group-a",
      label: "A",
      type: "connection-group",
      children: [
        {
          id: "conn-1",
          label: "c",
          type: "connection",
          connectionId: "conn-1",
          children: [
            { id: "conn-1:app", label: "app", type: "database", connectionId: "conn-1", database: "app", children: [{ id: "conn-1:app:public", label: "public", type: "schema", connectionId: "conn-1", database: "app", schema: "public", children: [groupTables] }] },
            { id: "conn-1:SYSTEM", label: "SYSTEM", type: "schema", connectionId: "conn-1", database: "", schema: "SYSTEM" },
          ],
        },
      ],
    },
  ];

  assert.deepEqual(
    regexTableSearchParents(live).map((node) => node.id),
    ["conn-1:app", "conn-1:app:public", "conn-1:app:public:__tables", "conn-1:SYSTEM"],
  );
});
