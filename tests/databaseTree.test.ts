import assert from "node:assert/strict";
import test from "node:test";
import { buildDatabaseTreeNodes } from "../src/lib/databaseTree.ts";

test("设置默认库后侧边栏数据库树仍保留全部数据库", () => {
  const nodes = buildDatabaseTreeNodes("conn-1", [
    { name: "campaign_data" },
    { name: "cms" },
    { name: "mk_campaign" },
  ]);

  assert.deepEqual(
    nodes.map((node) => node.database),
    ["campaign_data", "cms", "mk_campaign"],
  );
  assert.equal(nodes.find((node) => node.database === "mk_campaign")?.id, "conn-1:mk_campaign");
});
