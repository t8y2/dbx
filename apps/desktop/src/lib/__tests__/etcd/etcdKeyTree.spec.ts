import { describe, expect, it } from "vitest";
import { buildEtcdKeyTree, flattenVisibleEtcdKeyTree } from "@/lib/etcd/etcdKeyTree";

describe("etcd key tree", () => {
  it("groups slash-delimited keys", () => {
    const tree = buildEtcdKeyTree([
      { key: "/app/config/name", modRevision: 3 },
      { key: "/app/config/env", modRevision: 4 },
      { key: "/service/api", modRevision: 5 },
    ]);

    expect(tree.map((node) => node.label)).toEqual(["app", "service"]);
    const app = tree[0];
    expect(app.kind).toBe("group");
    if (app.kind === "group") {
      expect(app.children.map((node) => node.label)).toEqual(["config"]);
    }
  });

  it("flattens only expanded groups", () => {
    const tree = buildEtcdKeyTree([{ key: "/app/config/name" }, { key: "/plain" }]);
    const rows = flattenVisibleEtcdKeyTree(tree, new Set(["group:app"]));

    expect(rows.map((row) => `${row.depth}:${row.node.label}`)).toEqual(["0:app", "1:config", "0:plain"]);
  });
});
