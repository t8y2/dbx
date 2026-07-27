import { describe, expect, it } from "vitest";
import { TreeNodeLoadRegistry, type TreeNodeLike } from "@/lib/metadata/treeNodeLoadHandle";

describe("TreeNodeLoadRegistry", () => {
  it("allows apply and finish only for the current generation", () => {
    const registry = new TreeNodeLoadRegistry();
    const node: TreeNodeLike = { id: "c1:db", connectionId: "c1", isLoading: false, children: [] };
    const findLive = (id: string) => (id === node.id ? node : null);
    const isConnected = (id: string) => id === "c1";

    const first = registry.begin(node);
    expect(node.isLoading).toBe(true);
    expect(first.targetNode(findLive, isConnected)).toBe(node);

    const second = registry.begin(node);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    expect(first.targetNode(findLive, isConnected)).toBeNull();

    first.finish(findLive);
    expect(node.isLoading).toBe(true);

    second.finish(findLive);
    expect(node.isLoading).toBe(false);
  });

  it("invalidates connection subtree loads and clears sticky spinners", () => {
    const registry = new TreeNodeLoadRegistry();
    const db: TreeNodeLike = { id: "c1:db", connectionId: "c1", isLoading: false, children: [] };
    const root: TreeNodeLike = { id: "c1", connectionId: "c1", isLoading: false, children: [db] };
    const load = registry.begin(db);
    expect(db.isLoading).toBe(true);

    registry.invalidateConnection("c1", root);
    expect(load.isCurrent()).toBe(false);
    expect(db.isLoading).toBe(false);

    const reclaimed = load.reclaim(db);
    expect(reclaimed.isCurrent()).toBe(true);
    expect(db.isLoading).toBe(true);
    expect(
      reclaimed.targetNode(
        (id) => (id === db.id ? db : null),
        (id) => id === "c1",
      ),
    ).toBe(db);
  });

  it("rejects apply when disconnected even if generation is current", () => {
    const registry = new TreeNodeLoadRegistry();
    const node: TreeNodeLike = { id: "c1:db", connectionId: "c1", isLoading: false, children: [] };
    const load = registry.begin(node);
    expect(
      load.targetNode(
        (id) => (id === node.id ? node : null),
        () => false,
      ),
    ).toBeNull();
  });

  it("force begin supersedes prior handle without connection revision", () => {
    const registry = new TreeNodeLoadRegistry();
    const node: TreeNodeLike = { id: "c1:db", connectionId: "c1", isLoading: false, children: [] };
    const findLive = (id: string) => (id === node.id ? node : null);
    const isConnected = () => true;

    const stale = registry.begin(node);
    const fresh = registry.begin(node);
    expect(stale.targetNode(findLive, isConnected)).toBeNull();
    expect(fresh.targetNode(findLive, isConnected)).toBe(node);
    stale.finish(findLive);
    expect(node.isLoading).toBe(true);
    fresh.finish(findLive);
    expect(node.isLoading).toBe(false);
  });
});
