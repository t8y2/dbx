import assert from "node:assert/strict";
import { test } from "vitest";
import { buildDatabaseTreeNodes, sortSidebarNames } from "../../apps/desktop/src/lib/databaseTree.ts";

test("数据库节点按自然名称排序", () => {
  const nodes = buildDatabaseTreeNodes("conn-1", [{ name: "db10" }, { name: "db2" }, { name: "campaign_data" }, { name: "cms" }, { name: "mk_campaign" }]);

  assert.deepEqual(
    nodes.map((node) => node.database),
    ["campaign_data", "cms", "db2", "db10", "mk_campaign"],
  );
  assert.equal(nodes.find((node) => node.database === "mk_campaign")?.id, "conn-1:mk_campaign");
});

test("sidebar name sorting uses numeric-aware ordering", () => {
  assert.deepEqual(sortSidebarNames(["db10", "db2", "db1"]), ["db1", "db2", "db10"]);
});
