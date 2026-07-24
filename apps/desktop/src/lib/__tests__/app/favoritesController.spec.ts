import { describe, expect, it } from "vitest";
import { FavoritesController, type FavoritesControllerOptions } from "@/lib/app/favorites/controller";
import type { FavoriteGroup, TreeNode } from "@/types/database";

function buildController(): FavoritesController {
  const options: FavoritesControllerOptions = { isDesktop: false, loadRemote: async () => null };
  return new FavoritesController(options, { persist: () => undefined, refreshTree: () => undefined });
}

function buildTable(id: string, label: string, connectionId: string, database: string): TreeNode {
  return { id, label, type: "table", connectionId, database };
}

describe("FavoritesController.getFavoriteGroupForKey", () => {
  it("returns null for a key that is not favorited", () => {
    const controller = buildController();
    expect(controller.getFavoriteGroupForKey("missing")).toBeNull();
  });

  it("returns the group currently owning a favorited key", () => {
    const controller = buildController();
    const table = buildTable("c1:a:t1", "t1", "c1", "a");
    controller.toggleTreeNodeFavorite(table);
    const key = controller.getFavoriteKeyForNode(table);
    expect(key).not.toBeNull();
    const group = controller.getFavoriteGroupForKey(key!);
    expect(group).not.toBeNull();
    expect(group!.name).toBe("Default");
  });
});

describe("FavoritesController.getFavoriteGroupsForDatabase", () => {
  it("lazily creates a single Default group on first favorite", () => {
    const controller = buildController();
    const table = buildTable("c1:a:t1", "t1", "c1", "a");
    expect(controller.getFavoriteGroupsForDatabase("c1", "a")).toEqual([]);
    controller.toggleTreeNodeFavorite(table);
    const groups = controller.getFavoriteGroupsForDatabase("c1", "a");
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("Default");
  });

  it("returns the default plus any custom groups, ordered by `order`", () => {
    const controller = buildController();
    const table = buildTable("c1:a:t1", "t1", "c1", "a");
    // Toggling a favorite lazily materializes the default group so it shows
    // up alongside the custom groups below.
    controller.toggleTreeNodeFavorite(table);
    controller.createFavoriteGroup("c1", "a", "alpha");
    controller.createFavoriteGroup("c1", "a", "beta");
    const groups = controller.getFavoriteGroupsForDatabase("c1", "a");
    expect(groups.map((group: FavoriteGroup) => group.name)).toEqual(["Default", "alpha", "beta"]);
  });

  it("does not leak groups from another (connection, database) scope", () => {
    const controller = buildController();
    const tableA = buildTable("c1:a:t1", "t1", "c1", "a");
    const tableB = buildTable("c2:b:t1", "t1", "c2", "b");
    controller.toggleTreeNodeFavorite(tableA);
    controller.toggleTreeNodeFavorite(tableB);
    controller.createFavoriteGroup("c1", "a", "alpha");
    controller.createFavoriteGroup("c2", "b", "beta");
    expect(controller.getFavoriteGroupsForDatabase("c1", "a").map((g: FavoriteGroup) => g.name)).toEqual(["Default", "alpha"]);
    expect(controller.getFavoriteGroupsForDatabase("c2", "b").map((g: FavoriteGroup) => g.name)).toEqual(["Default", "beta"]);
  });
});

describe("FavoritesController.addFavoriteToGroup", () => {
  it("adds an unfavorited table to the chosen group", () => {
    const controller = buildController();
    const table = buildTable("c1:a:t1", "t1", "c1", "a");
    const custom = controller.createFavoriteGroup("c1", "a", "custom");
    expect(controller.addFavoriteToGroup(table, custom.id)).toBe(true);
    const key = controller.getFavoriteKeyForNode(table)!;
    expect(controller.getFavoriteGroupForKey(key)?.id).toBe(custom.id);
  });

  it("returns false when the node is already favorited (use moveFavoriteToGroup instead)", () => {
    const controller = buildController();
    const table = buildTable("c1:a:t1", "t1", "c1", "a");
    const custom = controller.createFavoriteGroup("c1", "a", "custom");
    controller.toggleTreeNodeFavorite(table);
    expect(controller.addFavoriteToGroup(table, custom.id)).toBe(false);
    // Item is still owned by the Default group from the toggle above.
    const key = controller.getFavoriteKeyForNode(table)!;
    expect(controller.getFavoriteGroupForKey(key)?.id).not.toBe(custom.id);
  });

  it("returns false for a non-favoritable node type", () => {
    const controller = buildController();
    const procedure: TreeNode = { id: "c1:a:p1", label: "p1", type: "procedure", connectionId: "c1", database: "a" };
    const custom = controller.createFavoriteGroup("c1", "a", "custom");
    expect(controller.addFavoriteToGroup(procedure, custom.id)).toBe(false);
  });
});

describe("FavoritesController.moveFavoriteToGroup", () => {
  it("re-targets an already-favorited key to a new group", () => {
    const controller = buildController();
    const table = buildTable("c1:a:t1", "t1", "c1", "a");
    controller.toggleTreeNodeFavorite(table);
    const custom = controller.createFavoriteGroup("c1", "a", "custom");
    const key = controller.getFavoriteKeyForNode(table)!;
    expect(controller.moveFavoriteToGroup(key, custom.id)).toBe(true);
    expect(controller.getFavoriteGroupForKey(key)?.id).toBe(custom.id);
  });

  it("returns false when the key is not favorited", () => {
    const controller = buildController();
    const custom = controller.createFavoriteGroup("c1", "a", "custom");
    expect(controller.moveFavoriteToGroup("missing", custom.id)).toBe(false);
  });

  it("returns false when the destination group does not exist", () => {
    const controller = buildController();
    const table = buildTable("c1:a:t1", "t1", "c1", "a");
    controller.toggleTreeNodeFavorite(table);
    const key = controller.getFavoriteKeyForNode(table)!;
    expect(controller.moveFavoriteToGroup(key, "missing-group")).toBe(false);
  });
});

describe("FavoritesController.removeFavorite", () => {
  it("removes a favorited key and resolves the lookup to null afterwards", () => {
    const controller = buildController();
    const table = buildTable("c1:a:t1", "t1", "c1", "a");
    controller.toggleTreeNodeFavorite(table);
    const key = controller.getFavoriteKeyForNode(table)!;
    expect(controller.removeFavorite(key)).toBe(true);
    expect(controller.getFavoriteKeyForNode(table)).toBeNull();
    expect(controller.getFavoriteGroupForKey(key)).toBeNull();
  });

  it("returns false when the key is not favorited", () => {
    const controller = buildController();
    expect(controller.removeFavorite("missing")).toBe(false);
  });
});

describe("FavoritesController.favoriteKeyForNode", () => {
  it("returns a stable key for a favoritable node regardless of favorite state", () => {
    // The submenu and the row label both rely on a non-null key being
    // produced even when the node is not yet favorited — the callers use
    // the key to find a current group (null in that case) and to address
    // the item when moving it.
    const controller = buildController();
    const table = buildTable("c1:a:t1", "t1", "c1", "a");
    const keyBefore = controller.favoriteKeyForNode(table);
    controller.toggleTreeNodeFavorite(table);
    const keyAfter = controller.favoriteKeyForNode(table);
    expect(keyBefore).not.toBeNull();
    expect(keyAfter).toBe(keyBefore);
  });

  it("returns null for a non-favoritable node type", () => {
    const controller = buildController();
    const procedure: TreeNode = { id: "c1:a:p1", label: "p1", type: "procedure", connectionId: "c1", database: "a" };
    expect(controller.favoriteKeyForNode(procedure)).toBeNull();
  });

  it("returns null when the node is missing a connectionId", () => {
    const controller = buildController();
    const table: TreeNode = { id: "t1", label: "t1", type: "table" };
    expect(controller.favoriteKeyForNode(table)).toBeNull();
  });
});

describe("FavoritesController: submenu orchestration contract", () => {
  // The right-click "Add to Favorites" submenu collapses add/move/remove
  // into a single picker. This block pins the public-API contract the
  // submenu relies on so future refactors don't silently break the
  // "click current group → remove" behavior.

  it("adds an unfavorited table to a freshly-created group", () => {
    const controller = buildController();
    const table = buildTable("c1:a:t1", "t1", "c1", "a");
    const custom = controller.createFavoriteGroup("c1", "a", "work");
    expect(controller.addFavoriteToGroup(table, custom.id)).toBe(true);
    const key = controller.getFavoriteKeyForNode(table)!;
    expect(controller.getFavoriteGroupForKey(key)?.id).toBe(custom.id);
  });

  it("moves an already-favorited table when the picked group differs", () => {
    const controller = buildController();
    const table = buildTable("c1:a:t1", "t1", "c1", "a");
    controller.toggleTreeNodeFavorite(table);
    const custom = controller.createFavoriteGroup("c1", "a", "work");
    const key = controller.getFavoriteKeyForNode(table)!;
    expect(controller.moveFavoriteToGroup(key, custom.id)).toBe(true);
    expect(controller.getFavoriteGroupForKey(key)?.id).toBe(custom.id);
  });

  it("removes the table when the picked group matches its current group", () => {
    // The submenu presents the current group with a leading ✓ to signal
    // that picking it again toggles the favorite off.
    const controller = buildController();
    const table = buildTable("c1:a:t1", "t1", "c1", "a");
    const custom = controller.createFavoriteGroup("c1", "a", "work");
    controller.addFavoriteToGroup(table, custom.id);
    const key = controller.getFavoriteKeyForNode(table)!;
    expect(controller.getFavoriteGroupForKey(key)?.id).toBe(custom.id);
    expect(controller.removeFavorite(key)).toBe(true);
    expect(controller.getFavoriteKeyForNode(table)).toBeNull();
  });

  it("does not allow adding a procedure to any group", () => {
    const controller = buildController();
    const procedure: TreeNode = { id: "c1:a:p1", label: "p1", type: "procedure", connectionId: "c1", database: "a" };
    const custom = controller.createFavoriteGroup("c1", "a", "work");
    expect(controller.addFavoriteToGroup(procedure, custom.id)).toBe(false);
  });
});
