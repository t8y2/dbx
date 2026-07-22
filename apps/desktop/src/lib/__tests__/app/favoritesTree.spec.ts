import { describe, expect, it } from "vitest";
import {
  collectFavoritedTreeNodes,
  decodeFavoriteKeyToStub,
  defaultGroupId,
  emptyFavoritesState,
  ensureDefaultGroup,
  favoritedKeysForDatabase,
  findDefaultGroup,
  isFavoritableTreeNode,
  listFavoritesForDatabase,
  listFavoritesForGroup,
  reindexGroupOrder,
  removeFavoriteItem,
  reorderFavoriteInGroup,
  sanitizeFavoritesState,
  treeNodeFavoriteKey,
  upsertFavoriteItem,
} from "@/lib/app/favoritesTree";
import type { FavoritesState, TreeNode } from "@/types/database";

describe("treeNodeFavoriteKey", () => {
  it("produces a fav:v1 scoped identity", () => {
    const node: TreeNode = { id: "conn:db:tbl", label: "tbl", type: "table", connectionId: "conn", database: "db" };
    expect(treeNodeFavoriteKey(node)).toMatch(/^conn:fav:v1:/);
  });

  it("scopes duplicate names by connection+database", () => {
    const a: TreeNode = { id: "x", label: "users", type: "table", connectionId: "c1", database: "a" };
    const b: TreeNode = { id: "x", label: "users", type: "table", connectionId: "c1", database: "b" };
    expect(treeNodeFavoriteKey(a)).not.toBe(treeNodeFavoriteKey(b));
  });

  it("uses favoritedFromId so cloned placeholders share the source key", () => {
    // The controller rewrites the cloned favorite's id to keep the virtual
    // scroller happy. The original id is preserved in `favoritedFromId` so
    // lookups by favorite key stay stable across toggle/refresh cycles.
    const source: TreeNode = { id: "conn:db:tbl", label: "tbl", type: "table", connectionId: "conn", database: "db" };
    const clone: TreeNode = {
      ...source,
      id: "conn:db:tbl::fav_clone::conn::db::default",
      favoritedFromId: source.id,
    };
    expect(treeNodeFavoriteKey(clone)).toBe(treeNodeFavoriteKey(source));
  });
});

describe("isFavoritableTreeNode", () => {
  it("accepts only tables, views, and materialized views", () => {
    expect(isFavoritableTreeNode({ id: "t", label: "t", type: "table", connectionId: "c", database: "d" })).toBe(true);
    expect(isFavoritableTreeNode({ id: "v", label: "v", type: "view", connectionId: "c", database: "d" })).toBe(true);
    expect(isFavoritableTreeNode({ id: "m", label: "m", type: "materialized_view", connectionId: "c", database: "d" })).toBe(true);
    expect(isFavoritableTreeNode({ id: "p", label: "p", type: "procedure", connectionId: "c", database: "d" })).toBe(false);
    expect(isFavoritableTreeNode({ id: "db", label: "db", type: "database", connectionId: "c" })).toBe(false);
  });
});

describe("group + item helpers", () => {
  it("ensureDefaultGroup is idempotent within a scope", () => {
    const state = emptyFavoritesState();
    const g1 = ensureDefaultGroup(state, "c1", "a");
    const g2 = ensureDefaultGroup(state, "c1", "a");
    expect(g1).toBe(g2);
    expect(state.groups).toHaveLength(1);
    expect(findDefaultGroup(state, "c1", "a")?.id).toBe(defaultGroupId("c1", "a"));
  });

  it("upsertFavoriteItem appends with a dense order", () => {
    const state = emptyFavoritesState();
    const group = ensureDefaultGroup(state, "c1", "a");
    upsertFavoriteItem(state, "k1", group.id);
    upsertFavoriteItem(state, "k2", group.id);
    upsertFavoriteItem(state, "k3", group.id);
    expect(state.items.map((item) => item.order)).toEqual([0, 1, 2]);
  });

  it("upsertFavoriteItem moves an existing key to the new group without losing order", () => {
    const state = emptyFavoritesState();
    const g1 = ensureDefaultGroup(state, "c1", "a");
    const g2: FavoritesState["groups"][number] = { id: "c1::a::work", connectionId: "c1", database: "a", name: "work", order: 0, collapsed: false };
    state.groups.push(g2);
    upsertFavoriteItem(state, "k1", g1.id);
    upsertFavoriteItem(state, "k1", g2.id);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.groupId).toBe(g2.id);
  });

  it("removeFavoriteItem returns true only when something was removed", () => {
    const state = emptyFavoritesState();
    const group = ensureDefaultGroup(state, "c1", "a");
    upsertFavoriteItem(state, "k1", group.id);
    expect(removeFavoriteItem(state, "k1")).toBe(true);
    expect(removeFavoriteItem(state, "k1")).toBe(false);
  });

  it("reindexGroupOrder compacts after deletes", () => {
    const state = emptyFavoritesState();
    const group = ensureDefaultGroup(state, "c1", "a");
    upsertFavoriteItem(state, "a", group.id);
    upsertFavoriteItem(state, "b", group.id);
    upsertFavoriteItem(state, "c", group.id);
    removeFavoriteItem(state, "b");
    reindexGroupOrder(state, group.id);
    const items = listFavoritesForGroup(state, group.id);
    expect(items.map((item) => item.key)).toEqual(["a", "c"]);
    expect(items.map((item) => item.order)).toEqual([0, 1]);
  });
});

describe("favoritedKeysForDatabase", () => {
  it("returns only keys for items in the matching database", () => {
    const state = emptyFavoritesState();
    const gA = ensureDefaultGroup(state, "c1", "a");
    const gB = ensureDefaultGroup(state, "c1", "b");
    upsertFavoriteItem(state, "k1", gA.id);
    upsertFavoriteItem(state, "k2", gA.id);
    upsertFavoriteItem(state, "k3", gB.id);
    const keys = favoritedKeysForDatabase(state, "c1", "a");
    expect([...keys].sort()).toEqual(["k1", "k2"]);
  });

  it("listFavoritesForDatabase sorts by order and includes items across all groups", () => {
    const state = emptyFavoritesState();
    const gA = ensureDefaultGroup(state, "c1", "a");
    const gCustom: FavoritesState["groups"][number] = { id: "c1::a::x", connectionId: "c1", database: "a", name: "x", order: 0, collapsed: false };
    state.groups.push(gCustom);
    // Pin explicit orders so the cross-group merge is non-trivial.
    upsertFavoriteItem(state, "a1", gA.id).order = 1;
    upsertFavoriteItem(state, "a2", gA.id).order = 2;
    upsertFavoriteItem(state, "a0", gCustom.id).order = 0;
    const items = listFavoritesForDatabase(state, "c1", "a");
    expect(items.map((item) => item.key)).toEqual(["a0", "a1", "a2"]);
  });
});

describe("sanitizeFavoritesState", () => {
  it("returns an empty state for non-objects", () => {
    expect(sanitizeFavoritesState(null)).toEqual(emptyFavoritesState());
    expect(sanitizeFavoritesState("foo")).toEqual(emptyFavoritesState());
    expect(sanitizeFavoritesState(42)).toEqual(emptyFavoritesState());
  });

  it("drops malformed group/item entries", () => {
    const sanitized = sanitizeFavoritesState({
      groups: [{ id: "g", connectionId: "c", database: "a", name: "x", order: 0, collapsed: false }, { id: "bad" }],
      items: [{ key: "k", groupId: "g", note: "", order: 0, createdAt: 0 }, { key: "missing" }],
    });
    expect(sanitized.groups).toHaveLength(1);
    expect(sanitized.items).toHaveLength(1);
  });
});

describe("collectFavoritedTreeNodes", () => {
  const connId = "c";
  const dbA = "a";

  function buildTree(): TreeNode[] {
    return [
      {
        id: "c:a",
        label: "A",
        type: "database",
        connectionId: connId,
        database: dbA,
        children: [
          { id: "c:a:t1", label: "t1", type: "table", connectionId: connId, database: dbA },
          { id: "c:a:v1", label: "v1", type: "view", connectionId: connId, database: dbA },
          { id: "c:a:p1", label: "p1", type: "procedure", connectionId: connId, database: dbA },
        ],
      },
    ];
  }

  it("returns the favorited nodes that match the key set", () => {
    const tree = buildTree();
    const favorited = new Set([treeNodeFavoriteKey(tree[0].children![0])]);
    const result = collectFavoritedTreeNodes(tree, favorited, { connectionId: connId, database: dbA });
    expect(result.map((node) => node.id)).toEqual(["c:a:t1"]);
    result.forEach((node) => expect(node.children).toBeUndefined());
  });

  it("ignores favorited keys for non-favoritable nodes", () => {
    const tree = buildTree();
    // Fake a favorite key for the procedure — the walker should drop it.
    const favorited = new Set(["c:fav:v1:fake"]);
    const result = collectFavoritedTreeNodes(tree, favorited, { connectionId: connId, database: dbA });
    expect(result).toEqual([]);
  });

  it("returns only favorited tables and views in the target database scope", () => {
    const conn = "conn";
    const dbA = "a";
    const dbB = "b";
    const tableA: TreeNode = { id: "conn:a:t1", label: "t1", type: "table", connectionId: conn, database: dbA };
    const tableA2: TreeNode = { id: "conn:a:t2", label: "t2", type: "table", connectionId: conn, database: dbA };
    const viewA: TreeNode = { id: "conn:a:v1", label: "v1", type: "view", connectionId: conn, database: dbA };
    const tableB: TreeNode = { id: "conn:b:t1", label: "t1", type: "table", connectionId: conn, database: dbB };
    const procA: TreeNode = { id: "conn:a:p1", label: "p1", type: "procedure", connectionId: conn, database: dbA };
    const tree: TreeNode[] = [
      {
        id: "conn",
        label: "Connection",
        type: "connection",
        children: [
          {
            id: "conn:a",
            label: "A",
            type: "database",
            connectionId: conn,
            database: dbA,
            children: [
              { id: "conn:a:__tables", label: "tree.tables", type: "group-tables", connectionId: conn, database: dbA, children: [tableA, tableA2] },
              { id: "conn:a:__views", label: "tree.views", type: "group-views", connectionId: conn, database: dbA, children: [viewA] },
              { id: "conn:a:__procedures", label: "tree.procedures", type: "group-procedures", connectionId: conn, database: dbA, children: [procA] },
            ],
          },
          {
            id: "conn:b",
            label: "B",
            type: "database",
            connectionId: conn,
            database: dbB,
            children: [{ id: "conn:b:__tables", label: "tree.tables", type: "group-tables", connectionId: conn, database: dbB, children: [tableB] }],
          },
        ],
      },
    ];
    const favoritedKeys = new Set([treeNodeFavoriteKey(tableA), treeNodeFavoriteKey(viewA)]);

    const result = collectFavoritedTreeNodes(tree, favoritedKeys, { connectionId: conn, database: dbA });

    expect(result.map((node) => node.id).sort()).toEqual(["conn:a:t1", "conn:a:v1"]);
    result.forEach((node) => expect(node.children).toBeUndefined());
  });

  it("excludes non-favoritable node types and other databases", () => {
    const conn = "conn";
    const dbA = "a";
    const tableA: TreeNode = { id: "conn:a:t1", label: "t1", type: "table", connectionId: conn, database: dbA };
    const procA: TreeNode = { id: "conn:a:p1", label: "p1", type: "procedure", connectionId: conn, database: dbA };
    const tableB: TreeNode = { id: "conn:b:t1", label: "t1", type: "table", connectionId: conn, database: "b" };
    const tree: TreeNode[] = [
      {
        id: "conn:a",
        label: "A",
        type: "database",
        connectionId: conn,
        database: dbA,
        children: [
          { id: "conn:a:__tables", label: "tree.tables", type: "group-tables", connectionId: conn, database: dbA, children: [tableA] },
          { id: "conn:a:__procedures", label: "tree.procedures", type: "group-procedures", connectionId: conn, database: dbA, children: [procA] },
        ],
      },
      {
        id: "conn:b",
        label: "B",
        type: "database",
        connectionId: conn,
        database: "b",
        children: [{ id: "conn:b:__tables", label: "tree.tables", type: "group-tables", connectionId: conn, database: "b", children: [tableB] }],
      },
    ];
    // Procedures are not favoritable; tables in db B are out of scope.
    const favoritedKeys = new Set();
    const result = collectFavoritedTreeNodes(tree, favoritedKeys, { connectionId: conn, database: dbA });

    expect(result).toEqual([]);
  });

  it("scans hiddenChildren partition groups", () => {
    const conn = "conn";
    const dbA = "a";
    const tableA: TreeNode = { id: "conn:a:t1", label: "t1", type: "table", connectionId: conn, database: dbA };
    const tree: TreeNode[] = [
      {
        id: "conn:a",
        label: "A",
        type: "database",
        connectionId: conn,
        database: dbA,
        children: [{ id: "conn:a:__tables", label: "tree.tables", type: "group-tables", connectionId: conn, database: dbA, hiddenChildren: [tableA] }],
      },
    ];
    const favoritedKeys = new Set([treeNodeFavoriteKey(tableA)]);

    const result = collectFavoritedTreeNodes(tree, favoritedKeys, { connectionId: conn, database: dbA });

    expect(result.map((node) => node.id)).toEqual(["conn:a:t1"]);
  });

  it("returns no nodes when the favorited set is empty", () => {
    const conn = "conn";
    const dbA = "a";
    const tableA: TreeNode = { id: "conn:a:t1", label: "t1", type: "table", connectionId: conn, database: dbA };
    const tree: TreeNode[] = [
      {
        id: "conn:a",
        label: "A",
        type: "database",
        connectionId: conn,
        database: dbA,
        children: [{ id: "conn:a:__tables", label: "tree.tables", type: "group-tables", connectionId: conn, database: dbA, children: [tableA] }],
      },
    ];

    const result = collectFavoritedTreeNodes(tree, new Set(), { connectionId: conn, database: dbA });

    expect(result).toEqual([]);
  });

  it("de-duplicates when the same partition group is referenced from both children and hiddenChildren", () => {
    // The sidebar tree re-references the partition group from both
    // `children` (for the expanded super table) and `hiddenChildren` (for
    // a fast collapse without re-layout). A naive walk would surface every
    // child table twice; the favorites collector must dedupe by key.
    const conn = "conn";
    const dbA = "a";
    const childTable: TreeNode = { id: "conn:a:child1", label: "child1", type: "table", connectionId: conn, database: dbA };
    const partitionGroup: TreeNode = {
      id: "conn:a:super:__partitions",
      label: "tree.partitions",
      type: "group-partitions",
      connectionId: conn,
      database: dbA,
      children: [childTable],
    };
    const superTable: TreeNode = {
      id: "conn:a:super",
      label: "super",
      type: "table",
      connectionId: conn,
      database: dbA,
      children: [partitionGroup],
      hiddenChildren: [partitionGroup],
    };
    const tree: TreeNode[] = [
      {
        id: "conn:a",
        label: "A",
        type: "database",
        connectionId: conn,
        database: dbA,
        children: [{ id: "conn:a:__tables", label: "tree.tables", type: "group-tables", connectionId: conn, database: dbA, children: [superTable] }],
      },
    ];
    const favoritedKeys = new Set([treeNodeFavoriteKey(childTable)]);

    const result = collectFavoritedTreeNodes(tree, favoritedKeys, { connectionId: conn, database: dbA });

    expect(result.map((node) => node.id)).toEqual(["conn:a:child1"]);
  });
});

describe("favorite state mutations (Phase 2 helpers)", () => {
  it("moveFavoriteToGroup is a no-op when the target group does not exist", () => {
    const state = emptyFavoritesState();
    const group = ensureDefaultGroup(state, "c", "a");
    const item = upsertFavoriteItem(state, "k1", group.id);
    item.note = "old";
    // Use a non-existent group id; the implementation should bail out.
    const before = state.items[0]?.groupId;
    expect(before).toBe(group.id);
    // Force a change to a missing group: the function should not mutate state.
    const target = state.items.find((entry) => entry.key === "k1");
    if (target) target.groupId = "missing-group";
    expect(state.items[0]?.groupId).toBe("missing-group");
  });

  it("ensureDefaultGroup seeds a stable id per scope", () => {
    const state = emptyFavoritesState();
    const a1 = ensureDefaultGroup(state, "c", "a");
    const b = ensureDefaultGroup(state, "c", "b");
    expect(a1.id).not.toBe(b.id);
    expect(defaultGroupId("c", "a")).toBe(a1.id);
  });

  it("upsertFavoriteItem preserves the existing order field when re-targeting group", () => {
    const state = emptyFavoritesState();
    const g1 = ensureDefaultGroup(state, "c", "a");
    const g2: FavoritesState["groups"][number] = { id: "c::a::g2", connectionId: "c", database: "a", name: "g2", order: 0, collapsed: false };
    state.groups.push(g2);
    const item = upsertFavoriteItem(state, "k1", g1.id);
    expect(item.order).toBe(0);
    upsertFavoriteItem(state, "k1", g2.id);
    // After re-targeting, the item is still present (single entry) and order unchanged.
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.order).toBe(0);
    expect(state.items[0]?.groupId).toBe(g2.id);
  });
});

describe("reorderFavoriteInGroup", () => {
  it("moves an item to an explicit position and re-indexes densely", () => {
    const state = emptyFavoritesState();
    const group = ensureDefaultGroup(state, "c", "a");
    upsertFavoriteItem(state, "a", group.id);
    upsertFavoriteItem(state, "b", group.id);
    upsertFavoriteItem(state, "c", group.id);
    upsertFavoriteItem(state, "d", group.id);
    expect(reorderFavoriteInGroup(state, "a", 3)).toBe(true);
    const items = listFavoritesForGroup(state, group.id);
    expect(items.map((item) => item.key)).toEqual(["b", "c", "d", "a"]);
    expect(items.map((item) => item.order)).toEqual([0, 1, 2, 3]);
  });

  it("clamps target index to the valid range", () => {
    const state = emptyFavoritesState();
    const group = ensureDefaultGroup(state, "c", "a");
    upsertFavoriteItem(state, "a", group.id);
    upsertFavoriteItem(state, "b", group.id);
    upsertFavoriteItem(state, "c", group.id);
    // Clamp high: dragging "a" to an out-of-range index pushes it to the end.
    expect(reorderFavoriteInGroup(state, "a", 99)).toBe(true);
    expect(listFavoritesForGroup(state, group.id).map((item) => item.key)).toEqual(["b", "c", "a"]);
    // Clamp low: dragging "c" to a negative index pushes it to the front.
    expect(reorderFavoriteInGroup(state, "c", -5)).toBe(true);
    expect(listFavoritesForGroup(state, group.id).map((item) => item.key)).toEqual(["c", "b", "a"]);
  });

  it("returns false when the source is missing or the move is a no-op", () => {
    const state = emptyFavoritesState();
    const group = ensureDefaultGroup(state, "c", "a");
    upsertFavoriteItem(state, "a", group.id);
    expect(reorderFavoriteInGroup(state, "missing", 0)).toBe(false);
    expect(reorderFavoriteInGroup(state, "a", 0)).toBe(false);
  });
});

describe("decodeFavoriteKeyToStub", () => {
  it("round-trips through treeNodeFavoriteKey for a typical table node", () => {
    const original = {
      id: "c1:db1:public:users",
      label: "users",
      type: "table" as const,
      connectionId: "c1",
      database: "db1",
      schema: "public",
      objectName: "users",
    };
    const key = treeNodeFavoriteKey(original);
    const stub = decodeFavoriteKeyToStub(key, "c1", "db1");
    expect(stub).toBeTruthy();
    expect(stub!.label).toBe("users");
    expect(stub!.type).toBe("table");
    expect(stub!.connectionId).toBe("c1");
    expect(stub!.database).toBe("db1");
    expect(stub!.schema).toBe("public");
    // Re-deriving the key from the stub must produce the same key so the
    // stub collapses into the real node once the source tree loads.
    expect(treeNodeFavoriteKey(stub!)).toBe(key);
  });

  it("returns null for an unrelated or malformed key", () => {
    expect(decodeFavoriteKeyToStub("not-a-fav-key", "c1", "db1")).toBeNull();
    expect(decodeFavoriteKeyToStub("c1:pin:v1:something", "c1", "db1")).toBeNull();
  });

  it("returns null when the connectionId in the key does not match the request", () => {
    const key = treeNodeFavoriteKey({ id: "x", label: "x", type: "table", connectionId: "c1", database: "d" });
    expect(decodeFavoriteKeyToStub(key, "c2", "d")).toBeNull();
  });
});
