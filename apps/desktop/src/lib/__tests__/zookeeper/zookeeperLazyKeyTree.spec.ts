import { describe, expect, it } from "vitest";
import { createLazyKvKeyTreeState, createZooKeeperChildPathDraft, flattenLazyKvKeyTree, replaceLazyKvChildren, resetLazyKvKeyTree } from "@/lib/zookeeper/zookeeperLazyKeyTree";

describe("zookeeper lazy key tree", () => {
  it("stores only the current path direct children on reset", () => {
    const state = createLazyKvKeyTreeState();

    resetLazyKvKeyTree(state, "/app");
    replaceLazyKvChildren(
      state,
      null,
      [
        { key: "/app/a", numChildren: 0, valueSize: 1 },
        { key: "/app/folder", numChildren: 2, valueSize: 0 },
      ],
      null,
    );

    expect(state.rootPath).toBe("/app");
    expect(state.roots.map((node) => node.key)).toEqual(["/app/a", "/app/folder"]);
    expect(flattenLazyKvKeyTree(state, new Set()).map((row) => `${row.depth}:${row.node.label}`)).toEqual(["0:a", "0:folder"]);
  });

  it("does not expose grandchildren until their parent is loaded", () => {
    const state = createLazyKvKeyTreeState("/");
    replaceLazyKvChildren(state, null, [{ key: "/app", numChildren: 1 }], null);

    expect(flattenLazyKvKeyTree(state, new Set(["lazy:/app"])).map((row) => row.node.key)).toEqual(["/app"]);

    replaceLazyKvChildren(state, "/app", [{ key: "/app/name", numChildren: 0 }], null);

    expect(flattenLazyKvKeyTree(state, new Set(["lazy:/app"])).map((row) => row.node.key)).toEqual(["/app", "/app/name"]);
  });

  it("keeps child pagination continuation on the owning node", () => {
    const state = createLazyKvKeyTreeState("/");
    replaceLazyKvChildren(state, null, [{ key: "/app", numChildren: 3 }], "root-next");
    replaceLazyKvChildren(state, "/app", [{ key: "/app/a", numChildren: 0 }], "child-next");

    const app = state.nodeByKey.get("/app");

    expect(state.rootContinuation).toBe("root-next");
    expect(app?.continuation).toBe("child-next");
  });

  it("does not prefill root as a creatable znode path", () => {
    expect(createZooKeeperChildPathDraft("")).toBe("");
    expect(createZooKeeperChildPathDraft("/")).toBe("");
    expect(createZooKeeperChildPathDraft("/app")).toBe("/app/");
    expect(createZooKeeperChildPathDraft("app/")).toBe("/app/");
  });
});
