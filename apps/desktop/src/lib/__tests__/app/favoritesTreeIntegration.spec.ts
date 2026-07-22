import { describe, expect, it, vi } from "vitest";
import type { FavoritesController } from "@/lib/app/favorites/controller";
import type { TreeNode } from "@/types/database";
import { ensureFavoritesPlaceholdersInTree } from "@/lib/app/favorites/treeIntegration";
import { isFavoritesPlaceholderNode } from "@/lib/table/tableTree";

/**
 * Regression guard for the bug where PostgreSQL (and any other DB with a
 * schema layer) rendered the same favorited item twice: once under the
 * database node, and once under every schema below it. The placeholder must
 * only live on `database` nodes; sub-views (`schema`, `linked-server-schema`,
 * `doris-catalog`) are intentionally not owners.
 *
 * Reported: favorites duplicated on PostgreSQL when a connection had
 * multiple schemas.
 */
describe("ensureFavoritesPlaceholdersInTree — placeholder ownership", () => {
  function stubController(): FavoritesController {
    return {
      computePlaceholderChildren: vi.fn(() => ({ children: [], objectCount: 0 })),
    } as unknown as FavoritesController;
  }

  function makePgLikeTree(): TreeNode[] {
    const conn = "pg-1";
    const db = "wdj";
    return [
      {
        id: `${conn}:${db}`,
        label: db,
        type: "database",
        connectionId: conn,
        database: db,
        children: [
          {
            id: `${conn}:${db}:public`,
            label: "public",
            type: "schema",
            connectionId: conn,
            database: db,
            schema: "public",
            children: [
              { id: `${conn}:${db}:public:activity_log`, label: "activity_log", type: "table", connectionId: conn, database: db, schema: "public" },
            ],
          },
          {
            id: `${conn}:${db}:test`,
            label: "test",
            type: "schema",
            connectionId: conn,
            database: db,
            schema: "test",
            children: [],
          },
        ],
      },
    ];
  }

  it("attaches the placeholder to the database node but not to its schemas", () => {
    const tree = makePgLikeTree();
    ensureFavoritesPlaceholdersInTree(tree, stubController());

    const [db] = tree;
    expect(db!.type).toBe("database");
    expect(db!.children!.some(isFavoritesPlaceholderNode)).toBe(true);

    for (const schema of db!.children!.filter((c: TreeNode) => c.type === "schema")) {
      expect(schema.children!.some(isFavoritesPlaceholderNode)).toBe(false);
    }
  });

  it("does not duplicate a favorited item by rendering it under every schema", () => {
    const tree = makePgLikeTree();
    ensureFavoritesPlaceholdersInTree(tree, stubController());

    // Count the number of times activity_log appears across the tree.
    // Before the fix it appeared under both the database's favorites group
    // AND under public's favorites group.
    const matches: string[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.id?.endsWith("activity_log")) matches.push(n.id);
        if (n.children) walk(n.children);
        if (n.hiddenChildren) walk(n.hiddenChildren);
      }
    };
    walk(tree);
    expect(matches).toEqual([`pg-1:wdj:public:activity_log`]);
  });

  it("ignores linked-server-schema and doris-catalog nodes as placeholder owners", () => {
    const tree: TreeNode[] = [
      {
        id: "ms:db1",
        label: "db1",
        type: "database",
        connectionId: "ms",
        database: "db1",
        children: [
          {
            id: "ms:db1:catalogA",
            label: "catalogA",
            type: "doris-catalog",
            connectionId: "ms",
            database: "db1",
            catalog: "catalogA",
            children: [],
          },
          {
            id: "ms:db1:linked",
            label: "linked",
            type: "linked-server-schema",
            connectionId: "ms",
            database: "db1",
            schema: "linked",
            children: [],
          },
        ],
      },
    ];
    ensureFavoritesPlaceholdersInTree(tree, stubController());

    const [db] = tree;
    expect(db!.children!.some(isFavoritesPlaceholderNode)).toBe(true);
    for (const child of db!.children!) {
      expect(child.children!.some(isFavoritesPlaceholderNode)).toBe(false);
    }
  });
});
