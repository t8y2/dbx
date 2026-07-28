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

describe("connection root lookup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("finds a connection nested inside connection groups", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.treeNodes = [
      {
        id: "group-1",
        label: "Group",
        type: "connection-group",
        children: [{ id: "pg-1", label: "PG", type: "connection", connectionId: "pg-1", isExpanded: true, children: [{ id: "pg-1:db", label: "db", type: "database", connectionId: "pg-1" }] }],
      },
    ] as TreeNode[];
    store.connectedIds.add("pg-1");
    const conn = (store.treeNodes[0]!.children ?? [])[0]!;
    conn.isLoading = true;

    // markConnectionLost → clearConnectionNodeLoading 经连接根查找定位节点：
    // 分组内的连接必须能被找到并清除 loading
    store.markConnectionLost("pg-1", new Error("connection lost"));
    expect(conn.isLoading).toBe(false);
  });

  it("does not mistake a colliding deep node id for a connection root", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    // 深层节点 id 与连接 id 相同（构造性碰撞）：连接查找不得命中深层节点
    const collidingDeepNode: TreeNode = { id: "pg-1", label: "deep-collision", type: "schema", connectionId: "other" } as TreeNode;
    store.treeNodes = [
      { id: "other", label: "Other", type: "connection", connectionId: "other", children: [collidingDeepNode] },
      { id: "pg-1", label: "PG", type: "connection", connectionId: "pg-1", isExpanded: true, children: [] },
    ] as TreeNode[];
    store.connectedIds.add("pg-1");
    const realRoot = store.treeNodes[1]!;
    realRoot.isLoading = true;
    (collidingDeepNode as { isLoading?: boolean }).isLoading = true;

    store.markConnectionLost("pg-1", new Error("connection lost"));
    // 真正的连接根被清除 loading；深层碰撞节点不受影响
    expect(realRoot.isLoading).toBe(false);
    expect((collidingDeepNode as { isLoading?: boolean }).isLoading).toBe(true);
  });
});
