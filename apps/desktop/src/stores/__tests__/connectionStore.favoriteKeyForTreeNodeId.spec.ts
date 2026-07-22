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

describe("connectionStore.favoriteKeyForTreeNodeId", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  /**
   * Regression: the sidebar drag-and-drop channel only sees tree node ids
   * from the DOM (e.g. "pg-1:wdj:public:activity_log"). To reorder a
   * favorite the drop handler has to map that id back to the structured
   * fav:v1 key. Earlier code tried to derive the key by patching the
   * drag source's fields with the target id, which mixed the two and
   * produced wrong keys — so drops silently fell through to "no-op" and
   * the favorites group appeared un-draggable.
   */
  it("resolves a favoritable table's tree node id to the same key as favoriteKeyForNode", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const table: TreeNode = {
      id: "pg-1:wdj:public:activity_log",
      label: "activity_log",
      type: "table",
      connectionId: "pg-1",
      database: "wdj",
      schema: "public",
    };
    store.treeNodes = [
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
                id: "pg-1:wdj:public",
                label: "public",
                type: "schema",
                connectionId: "pg-1",
                database: "wdj",
                schema: "public",
                isExpanded: true,
                children: [table],
              },
            ],
          },
        ],
      },
    ] as TreeNode[];

    expect(store.favoriteKeyForNode(table)).toBe(store.favoriteKeyForTreeNodeId(table.id));
  });

  it("returns null for a tree node that is not favoritable (e.g. a connection)", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.treeNodes = [
      { id: "pg-1", label: "PG", type: "connection", connectionId: "pg-1" },
    ] as TreeNode[];
    expect(store.favoriteKeyForTreeNodeId("pg-1")).toBeNull();
  });

  it("returns null for an unknown id", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.treeNodes = [];
    expect(store.favoriteKeyForTreeNodeId("does-not-exist")).toBeNull();
  });
});
