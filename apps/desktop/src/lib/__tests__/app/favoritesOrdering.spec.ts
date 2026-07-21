import { describe, expect, it } from "vitest";
import { FavoritesController, type FavoritesControllerOptions } from "@/lib/app/favorites/controller";
import { buildFavoritesPlaceholderNode } from "@/lib/table/tableTree";
import type { TreeNode } from "@/types/database";

function buildController(): FavoritesController {
  const options: FavoritesControllerOptions = { isDesktop: false, loadRemote: async () => null };
  return new FavoritesController(options, { persist: () => undefined, refreshTree: () => undefined });
}

function buildTableNode(id: string, label: string, connectionId: string, database: string): TreeNode {
  return { id, label, type: "table", connectionId, database };
}

function buildPlaceholder(connectionId: string, database: string): TreeNode {
  return buildFavoritesPlaceholderNode({ nodeId: `${connectionId}:${database}`, connectionId, database });
}

describe("FavoritesController.computePlaceholderChildren ordering", () => {
  it("preserves the user's persisted order across re-renders", () => {
    const controller = buildController();

    const tableA = buildTableNode("c1:a:a", "activity_apply", "c1", "a");
    const tableB = buildTableNode("c1:a:b", "assessment_archive", "c1", "a");
    const tableC = buildTableNode("c1:a:c", "assessment_calculation_log", "c1", "a");
    const sourceTree: TreeNode[] = [{ id: "c1:a", label: "a", type: "database", connectionId: "c1", database: "a", children: [tableA, tableB, tableC] }];
    const placeholder = buildPlaceholder("c1", "a");

    // Add three items to the (lazy) default group, then manually re-order
    // them so calculation_log → archive → apply.
    controller.toggleTreeNodeFavorite(tableC); // first so its order is 0
    controller.toggleTreeNodeFavorite(tableB);
    controller.toggleTreeNodeFavorite(tableA);
    // Manually push them to a custom non-default order: c (0), b (1), a (2)
    const keyA = controller.getFavoriteKeyForNode(tableA)!;
    const keyB = controller.getFavoriteKeyForNode(tableB)!;
    const keyC = controller.getFavoriteKeyForNode(tableC)!;
    controller.moveFavoriteToEdge(keyC, "top");
    // moveFavoriteToEdge leaves c at the top, then re-indexes densely, so
    // c=0, b=1, a=2.
    expect(controller.getFavoriteItemForKey(keyC)?.order).toBe(0);
    expect(controller.getFavoriteItemForKey(keyB)?.order).toBe(1);
    expect(controller.getFavoriteItemForKey(keyA)?.order).toBe(2);

    const { children, objectCount } = controller.computePlaceholderChildren({
      connectionId: "c1",
      database: "a",
      parentId: placeholder.id,
      sourceTree,
    });

    expect(objectCount).toBe(3);
    expect(children.map((node) => node.label)).toEqual(["assessment_calculation_log", "assessment_archive", "activity_apply"]);
  });

  it("preserves the user's persisted order when wrapped under a favorites-group subnode", () => {
    // Reproduce the multi-group case from figure 2: the user has a `test`
    // group alongside Default, and the manual order inside Default must
    // survive every re-render of the placeholder.
    const controller = buildController();

    const tableA = buildTableNode("c1:a:a", "activity_apply", "c1", "a");
    const tableB = buildTableNode("c1:a:b", "assessment_archive", "c1", "a");
    const tableC = buildTableNode("c1:a:c", "assessment_calculation_log", "c1", "a");
    const sourceTree: TreeNode[] = [{ id: "c1:a", label: "a", type: "database", connectionId: "c1", database: "a", children: [tableA, tableB, tableC] }];
    const placeholder = buildPlaceholder("c1", "a");

    // Add the three items to the default group and arrange them as c, b, a
    // (the order shown in figure 1). We use reorderFavorite so the move
    // semantics match the drag-and-drop the user actually performed.
    controller.toggleTreeNodeFavorite(tableA);
    controller.toggleTreeNodeFavorite(tableB);
    controller.toggleTreeNodeFavorite(tableC);
    const keyA = controller.getFavoriteKeyForNode(tableA)!;
    const keyB = controller.getFavoriteKeyForNode(tableB)!;
    const keyC = controller.getFavoriteKeyForNode(tableC)!;
    // Initial state after toggling: a(0), b(1), c(2). Move c to top: c, a, b.
    controller.reorderFavorite(keyC, 0);
    // Now move b to index 1: c, b, a.
    controller.reorderFavorite(keyB, 1);
    expect(controller.getFavoriteItemForKey(keyC)?.order).toBe(0);
    expect(controller.getFavoriteItemForKey(keyB)?.order).toBe(1);
    expect(controller.getFavoriteItemForKey(keyA)?.order).toBe(2);

    // Create the test group, then re-render and check the order.
    controller.createFavoriteGroup("c1", "a", "test");
    const { children } = controller.computePlaceholderChildren({
      connectionId: "c1",
      database: "a",
      parentId: placeholder.id,
      sourceTree,
    });

    const defaultSubnode = children.find((node) => node.label === "Default");
    expect(defaultSubnode, "Default subnode should be present").toBeDefined();
    const defaultChildren = defaultSubnode!.children ?? [];
    expect(defaultChildren.map((node) => node.label)).toEqual(["assessment_calculation_log", "assessment_archive", "activity_apply"]);
  });

  it("preserves Default's order when the source tree already contains cloned subnodes (toggle test-group path)", () => {
    // Reproduce the exact user scenario: a sidebar tree whose favorites
    // placeholder already has Default + test subnodes populated with the
    // previous render. Toggling the test group's collapsed state must not
    // change the manual order inside Default.
    const controller = buildController();

    const tableA = buildTableNode("c1:a:a", "activity_apply", "c1", "a");
    const tableB = buildTableNode("c1:a:b", "assessment_archive", "c1", "a");
    const tableC = buildTableNode("c1:a:c", "assessment_calculation_log", "c1", "a");
    const placeholder = buildPlaceholder("c1", "a");

    // Arrange the items as c(0), b(1), a(2) in the Default group.
    controller.toggleTreeNodeFavorite(tableA);
    controller.toggleTreeNodeFavorite(tableB);
    controller.toggleTreeNodeFavorite(tableC);
    const keyB = controller.getFavoriteKeyForNode(tableB)!;
    const keyC = controller.getFavoriteKeyForNode(tableC)!;
    controller.reorderFavorite(keyC, 0);
    controller.reorderFavorite(keyB, 1);

    // Create the test group and render once to get a stable sourceTree.
    const testGroup = controller.createFavoriteGroup("c1", "a", "test");
    const firstRender = controller.computePlaceholderChildren({
      connectionId: "c1",
      database: "a",
      parentId: placeholder.id,
      sourceTree: [{ id: "c1:a", label: "a", type: "database", connectionId: "c1", database: "a", children: [tableA, tableB, tableC] }],
    });
    const firstDefault = firstRender.children.find((node) => node.label === "Default");
    expect(firstDefault?.children?.map((node) => node.label)).toEqual(["assessment_calculation_log", "assessment_archive", "activity_apply"]);

    // Build the full source tree containing the previously rendered
    // placeholder + subnodes (this is what the sidebar tree looks like in
    // production when the favorites placeholder has been hydrated). The
    // placeholder is always the first child of its parent because
    // `ensureFavoritesPlaceholdersInTree` unshifts it to the top.
    const defaultSubnode = firstRender.children.find((node) => node.label === "Default")!;
    const testSubnode = firstRender.children.find((node) => node.label === "test")!;
    const sourceTree: TreeNode[] = [
      {
        id: "c1:a",
        label: "a",
        type: "database",
        connectionId: "c1",
        database: "a",
        children: [{ ...placeholder, children: [defaultSubnode, testSubnode] }, tableA, tableB, tableC],
      },
    ];

    // Now flip the test group's collapsed state (this is what expanding the
    // test group triggers).
    controller.setFavoriteGroupCollapsed(testGroup.id, false);

    // Re-render with the same source tree; Default's order must be preserved.
    const { children } = controller.computePlaceholderChildren({
      connectionId: "c1",
      database: "a",
      parentId: placeholder.id,
      sourceTree,
    });
    const reDefault = children.find((node) => node.label === "Default");
    expect(reDefault?.children?.map((node) => node.label)).toEqual(["assessment_calculation_log", "assessment_archive", "activity_apply"]);
  });

  it("keeps the empty Default subnode visible when all items live in custom groups", () => {
    // Reproduce the sidebar screenshot: the user has moved every item out
    // of Default into the `test` group. The Default entry must remain in
    // the tree so the user can re-target items back to it.
    const controller = buildController();

    const tableA = buildTableNode("c1:a:a", "activity_apply", "c1", "a");
    const tableB = buildTableNode("c1:a:b", "assessment_archive", "c1", "a");
    const sourceTree: TreeNode[] = [{ id: "c1:a", label: "a", type: "database", connectionId: "c1", database: "a", children: [tableA, tableB] }];
    const placeholder = buildPlaceholder("c1", "a");

    // Add the items to Default, then create `test` and move both items into
    // it so Default ends up empty.
    controller.toggleTreeNodeFavorite(tableA);
    controller.toggleTreeNodeFavorite(tableB);
    const keyA = controller.getFavoriteKeyForNode(tableA)!;
    const keyB = controller.getFavoriteKeyForNode(tableB)!;
    const testGroup = controller.createFavoriteGroup("c1", "a", "test");
    controller.moveFavoriteToGroup(keyA, testGroup.id);
    controller.moveFavoriteToGroup(keyB, testGroup.id);

    const { children } = controller.computePlaceholderChildren({
      connectionId: "c1",
      database: "a",
      parentId: placeholder.id,
      sourceTree,
    });
    const labels = children.map((node) => node.label);
    expect(labels).toEqual(["Default", "test"]);
    const defaultSubnode = children.find((node) => node.label === "Default");
    expect(defaultSubnode).toBeDefined();
    expect(defaultSubnode?.children).toEqual([]);
  });

  it("populates subnode children when the source tree gains tables after a first-time load", () => {
    // Reproduce the "open a connection for the first time, expand the
    // favorites placeholder, then expand the `test` group" sequence. The
    // first render is computed before the parent (database) children are
    // loaded — so the source tree is empty. After `loadTables` finishes,
    // the source tree is rebuilt with the real tables; the second render
    // must show them under their respective groups.
    const controller = buildController();

    const tableA = buildTableNode("c1:a:a", "table_a", "c1", "a");
    const tableB = buildTableNode("c1:a:b", "table_b", "c1", "a");
    const placeholder = buildPlaceholder("c1", "a");

    // Pre-existing favorites: one in Default, one in `test`.
    controller.toggleTreeNodeFavorite(tableA);
    const testGroup = controller.createFavoriteGroup("c1", "a", "test");
    const keyA = controller.getFavoriteKeyForNode(tableA)!;
    controller.moveFavoriteToGroup(keyA, testGroup.id);
    controller.toggleTreeNodeFavorite(tableB);

    // First render: source tree has the database node but no children
    // (mirrors the state right after `ensureFavoritesNodesInTree` runs
    // during boot, before any table metadata is loaded).
    const emptySourceTree: TreeNode[] = [{ id: "c1:a", label: "a", type: "database", connectionId: "c1", database: "a" }];
    const first = controller.computePlaceholderChildren({
      connectionId: "c1",
      database: "a",
      parentId: placeholder.id,
      sourceTree: emptySourceTree,
    });
    const firstTest = first.children.find((node) => node.label === "test");
    const firstDefault = first.children.find((node) => node.label === "Default");
    expect(firstTest).toBeDefined();
    expect(firstDefault).toBeDefined();
    expect(firstTest?.children).toEqual([]);
    expect(firstDefault?.children).toEqual([]);

    // Now the sidebar host has triggered a table load; rebuild the source
    // tree with the real table nodes (mirrors what `loadTables` →
    // `setChildren` produces after the metadata returns).
    const loadedSourceTree: TreeNode[] = [
      {
        id: "c1:a",
        label: "a",
        type: "database",
        connectionId: "c1",
        database: "a",
        children: [tableA, tableB],
      },
    ];
    const second = controller.computePlaceholderChildren({
      connectionId: "c1",
      database: "a",
      parentId: placeholder.id,
      sourceTree: loadedSourceTree,
    });
    const secondTest = second.children.find((node) => node.label === "test");
    const secondDefault = second.children.find((node) => node.label === "Default");
    expect(secondTest?.children?.map((node) => node.label)).toEqual(["table_a"]);
    expect(secondDefault?.children?.map((node) => node.label)).toEqual(["table_b"]);
  });

  it("populates a placeholder that was attached with empty children when the parent was already loaded", () => {
    // Reproduce the "open a connection, expand the database (which calls
    // `setChildren` and attaches an empty-children placeholder), then
    // expand the favorites placeholder" sequence. The placeholder was
    // attached with `children: []` and never re-rendered. The toggle path
    // must therefore re-run `computePlaceholderChildren` so the favorited
    // tables surface without requiring the user to toggle a favorite
    // first.
    const controller = buildController();

    const tableA = buildTableNode("c1:a:a", "table_a", "c1", "a");
    const tableB = buildTableNode("c1:a:b", "table_b", "c1", "a");
    const placeholder = buildPlaceholder("c1", "a");

    // Pre-existing favorites: one in Default, one in `test`.
    controller.toggleTreeNodeFavorite(tableA);
    const testGroup = controller.createFavoriteGroup("c1", "a", "test");
    const keyA = controller.getFavoriteKeyForNode(tableA)!;
    controller.moveFavoriteToGroup(keyA, testGroup.id);
    controller.toggleTreeNodeFavorite(tableB);

    // The database has already been loaded by a previous user action
    // (e.g. the user expanded it before opening the favorites
    // placeholder). `setChildren` attached the placeholder with an
    // empty `children` array but did not run the favorites refresh.
    const loadedSourceTree: TreeNode[] = [
      {
        id: "c1:a",
        label: "a",
        type: "database",
        connectionId: "c1",
        database: "a",
        children: [tableA, tableB],
      },
    ];

    // The placeholder is still in the empty-children state from
    // `setChildren` — but a re-render (the fix) must populate it.
    const rendered = controller.computePlaceholderChildren({
      connectionId: "c1",
      database: "a",
      parentId: placeholder.id,
      sourceTree: loadedSourceTree,
    });
    const renderedTest = rendered.children.find((node: TreeNode) => node.label === "test");
    const renderedDefault = rendered.children.find((node: TreeNode) => node.label === "Default");
    expect(renderedTest?.children?.map((node: TreeNode) => node.label)).toEqual(["table_a"]);
    expect(renderedDefault?.children?.map((node: TreeNode) => node.label)).toEqual(["table_b"]);
  });
});
