import { describe, expect, it } from "vitest";
import { buildKvKeyTree, collectKvGroupIds, flattenVisibleKvKeyTree, preserveKvExpandedGroupIds } from "@/lib/kvKeyTree";

describe("kv key tree", () => {
  it("keeps root keys as leaf nodes", () => {
    const tree = buildKvKeyTree([{ key: "/plain", version: 2 }, { key: "/" }]);

    expect(tree.map((node) => `${node.kind}:${node.label}`)).toEqual(["leaf:/", "leaf:plain"]);
    expect(tree[1]).toMatchObject({ kind: "leaf", key: "/plain", version: 2 });
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
});
