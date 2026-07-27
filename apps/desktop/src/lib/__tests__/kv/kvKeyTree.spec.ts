import { describe, expect, it } from "vitest";
import { buildKvKeyTree, collectKvGroupIds, flattenVisibleKvKeyTree, kvKeyTreeNodePath, preserveKvExpandedGroupIds } from "@/lib/kv/kvKeyTree";

describe("kv key tree", () => {
  it("represents a key that is also a prefix as one expandable value node", () => {
    const tree = buildKvKeyTree([
      { key: "/app", modRevision: "2" },
      { key: "/app/name", modRevision: "3" },
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      kind: "group",
      label: "app",
      key: "/app",
      modRevision: "2",
      children: [{ kind: "leaf", key: "/app/name" }],
    });
  });

  it("keeps root keys as leaf nodes", () => {
    const tree = buildKvKeyTree([{ key: "/plain", version: 2 }, { key: "/" }]);

    expect(tree.map((node) => `${node.kind}:${node.label}`)).toEqual(["leaf:/", "leaf:plain"]);
    expect(tree[1]).toMatchObject({ kind: "leaf", key: "/plain", version: 2 });
  });

  it("keeps colliding display keys as distinct raw-byte leaves", () => {
    const binaryBytes = { encoding: "base64" as const, data: "/w==" };
    const utf8Bytes = { encoding: "utf8" as const, data: "[base64:/w==]" };
    const tree = buildKvKeyTree([
      { key: "[base64:/w==]", keyIdentity: "ff", keyBytes: binaryBytes },
      { key: "[base64:/w==]", keyIdentity: "5b6261736536343a2f773d3d5d", keyBytes: utf8Bytes },
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ kind: "group", id: "group:[base64:", label: "[base64:" });
    if (tree[0].kind !== "group") throw new Error("expected colliding display keys under their shared virtual directory");
    expect(tree[0].children.map((node) => node.id)).toEqual(["leaf:ff", "leaf:5b6261736536343a2f773d3d5d"]);
    expect(tree[0].children).toEqual([expect.objectContaining({ keyIdentity: "ff", keyBytes: binaryBytes }), expect.objectContaining({ keyIdentity: "5b6261736536343a2f773d3d5d", keyBytes: utf8Bytes })]);
  });

  it("groups slash-delimited keys and sorts groups before leaves", () => {
    const tree = buildKvKeyTree([
      { key: "/app/config/name", modRevision: 3 },
      { key: "/plain", modRevision: 4 },
      { key: "/app/config/env", modRevision: 5 },
      { key: "/service/api", modRevision: 6 },
    ]);

    expect(tree.map((node) => node.label)).toEqual(["app", "service", "plain"]);
    const app = tree[0];
    expect(app.kind).toBe("group");
    if (app.kind === "group") {
      expect(app.children.map((node) => node.label)).toEqual(["config"]);
    }
  });

  it("collects stable group ids", () => {
    const tree = buildKvKeyTree([{ key: "/app/config/name" }, { key: "/service/api" }]);

    expect([...collectKvGroupIds(tree)].sort()).toEqual(["group:app", "group:app\u0000config", "group:service"]);
  });

  it("flattens only expanded groups", () => {
    const tree = buildKvKeyTree([{ key: "/app/config/name" }, { key: "/plain" }]);
    const rows = flattenVisibleKvKeyTree(tree, new Set(["group:app"]));

    expect(rows.map((row) => `${row.depth}:${row.node.label}`)).toEqual(["0:app", "1:config", "0:plain"]);
  });

  it("preserves only expanded groups still present after reload", () => {
    const tree = buildKvKeyTree([{ key: "/app/config/name" }, { key: "/service/api" }]);
    const next = preserveKvExpandedGroupIds(tree, new Set(["group:app", "group:missing"]));

    expect([...next]).toEqual(["group:app"]);
    expect([...preserveKvExpandedGroupIds(tree, new Set(), true)].sort()).toEqual(["group:app", "group:app\u0000config", "group:service"]);
  });

  it("preserves whether a virtual directory has a leading slash", () => {
    expect(kvKeyTreeNodePath(buildKvKeyTree([{ key: "/app/config/name" }])[0])).toBe("/app");
    expect(kvKeyTreeNodePath(buildKvKeyTree([{ key: "app/config/name" }])[0])).toBe("app");
  });
});
