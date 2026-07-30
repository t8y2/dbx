import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

describe("connectionStore.getSourceCommentForFavorite", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  /**
   * Regression: the favorites group renders cloned rows whose `comment`
   * field is a snapshot taken at clone time. When the user favorites a
   * table before its comment metadata finishes loading (or when the
   * source tree is updated afterwards), the clone carries an empty
   * comment. The tooltip and the trailing comment area must still find
   * the latest comment in the source tree — not return the empty
   * snapshot and not stop at the cloned row that lives in front of the
   * schema/tables in the favorites placeholder.
   */
  it("returns the original table's comment when the clone carries an empty snapshot", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const originalId = "pg-1:wdj:public:activity_log";
    const cloneId = `${originalId}::fav_clone::default`;
    const tree: TreeNode[] = [
      {
        id: "pg-1",
        label: "PG",
        type: "connection",
        connectionId: "pg-1",
        isExpanded: true,
        children: [
          {
            id: "pg-1:wdj",
            label: "wdj",
            type: "database",
            connectionId: "pg-1",
            database: "wdj",
            isExpanded: true,
            children: [
              {
                id: "pg-1:wdj:favorites",
                label: "Favorites",
                type: "favorites",
                connectionId: "pg-1",
                database: "wdj",
                children: [
                  {
                    id: cloneId,
                    label: "activity_log",
                    type: "table",
                    connectionId: "pg-1",
                    database: "wdj",
                    schema: "public",
                    favoritedFromId: originalId,
                    // Empty snapshot — the bug we want to work around.
                    comment: undefined,
                  },
                ],
              },
              {
                id: "pg-1:wdj:public",
                label: "public",
                type: "schema",
                connectionId: "pg-1",
                database: "wdj",
                schema: "public",
                isExpanded: true,
                children: [
                  {
                    id: originalId,
                    label: "activity_log",
                    type: "table",
                    connectionId: "pg-1",
                    database: "wdj",
                    schema: "public",
                    comment: "Activity log table",
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    store.treeNodes = tree;
    const clone: TreeNode = {
      id: cloneId,
      label: "activity_log",
      type: "table",
      connectionId: "pg-1",
      database: "wdj",
      schema: "public",
      favoritedFromId: originalId,
    };
    expect(store.getSourceCommentForFavorite(clone)).toBe("Activity log table");
  });

  it("prefers the clone's own comment when the snapshot is already populated", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const originalId = "pg-1:wdj:public:activity_log";
    const cloneId = `${originalId}::fav_clone::default`;
    const tree: TreeNode[] = [
      {
        id: "pg-1",
        label: "PG",
        type: "connection",
        connectionId: "pg-1",
        children: [
          {
            id: "pg-1:wdj",
            label: "wdj",
            type: "database",
            connectionId: "pg-1",
            database: "wdj",
            children: [
              {
                id: "pg-1:wdj:public",
                label: "public",
                type: "schema",
                connectionId: "pg-1",
                database: "wdj",
                schema: "public",
                children: [
                  {
                    id: originalId,
                    label: "activity_log",
                    type: "table",
                    connectionId: "pg-1",
                    database: "wdj",
                    schema: "public",
                    comment: "Source comment",
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    store.treeNodes = tree;
    const clone: TreeNode = {
      id: cloneId,
      label: "activity_log",
      type: "table",
      connectionId: "pg-1",
      database: "wdj",
      schema: "public",
      favoritedFromId: originalId,
      comment: "Stale snapshot comment",
    };
    // Clone's own comment wins — no need to walk the tree.
    expect(store.getSourceCommentForFavorite(clone)).toBe("Stale snapshot comment");
  });

  it("returns null when the source tree has no matching node", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.treeNodes = [];
    const orphan: TreeNode = {
      id: "missing::fav_clone::default",
      label: "missing",
      type: "table",
      connectionId: "pg-1",
      database: "wdj",
      schema: "public",
      favoritedFromId: "missing",
    };
    expect(store.getSourceCommentForFavorite(orphan)).toBeNull();
  });
});
