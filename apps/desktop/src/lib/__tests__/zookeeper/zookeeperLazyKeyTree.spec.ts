import { describe, expect, it } from "vitest";
import { createLazyKvKeyTreeState, createZooKeeperChildPathDraft, flattenLazyKvKeyTree, replaceLazyKvChildren, replaceLazyKvFocusedRoot, resetLazyKvKeyTree } from "@/lib/zookeeper/zookeeperLazyKeyTree";

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

  it("keeps an exact focused Key without children as a leaf", () => {
    const state = createLazyKvKeyTreeState("", "relative");

    replaceLazyKvFocusedRoot(state, { key: "dbx-demo/locks/persistent", numChildren: 0, valueSize: 12, hasValue: true }, [], null);

    const leaf = state.nodeByKey.get("dbx-demo/locks/persistent");
    expect(leaf?.hasChildren).toBe(false);
    expect(leaf?.hasValue).toBe(true);
    expect(leaf?.label).toBe("persistent");
  });

  it("keeps a real Consul Key and its child prefix as one dual-purpose node", () => {
    const state = createLazyKvKeyTreeState("", "relative");

    replaceLazyKvFocusedRoot(state, { key: "applications", numChildren: 1, valueSize: 7, hasValue: true }, [{ key: "applications/api", numChildren: 0, valueSize: 3 }], null);

    const root = state.nodeByKey.get("applications");
    expect(root?.hasValue).toBe(true);
    expect(root?.hasChildren).toBe(true);
    expect(root?.children.map((child) => child.key)).toEqual(["applications/api"]);
  });

  it("requires an exact GET before treating a trailing-slash Consul path as a Key", () => {
    const state = createLazyKvKeyTreeState("", "relative");

    replaceLazyKvChildren(state, null, [{ key: "applications/", numChildren: 2 }], null);

    const prefix = state.nodeByKey.get("applications/");
    expect(prefix?.hasChildren).toBe(true);
    expect(prefix?.hasValue).toBeNull();

    replaceLazyKvFocusedRoot(state, { key: "applications/", numChildren: 0, hasValue: true }, [], null);
    const exactTrailingSlashKey = state.nodeByKey.get("applications/");
    expect(exactTrailingSlashKey?.hasChildren).toBe(false);
    expect(exactTrailingSlashKey?.hasValue).toBe(true);
  });
});
