import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRedisKeyTree,
  collectExpandedGroupIds,
  flattenVisibleRedisKeyTree,
  type RedisKeyTreeNode,
} from "../src/lib/redisKeyTree.ts";
import type { RedisKeyInfo } from "../src/lib/api.ts";

function makeKey(key_display: string, key_raw: string, key_type = "string", ttl = -1): RedisKeyInfo {
  return { key_display, key_raw, key_type, ttl };
}

function leafLabels(nodes: RedisKeyTreeNode[]): string[] {
  return nodes.filter((node) => node.kind === "leaf").map((node) => node.label);
}

test("buildRedisKeyTree groups colon-delimited keys by segment", () => {
  const tree = buildRedisKeyTree(
    [makeKey("a:b:c", "k1"), makeKey("a:b:d", "k2"), makeKey("a:e", "k3"), makeKey("x", "k4")],
    0,
  );

  assert.equal(tree.length, 2);
  assert.equal(tree[0]?.kind, "group");
  assert.equal(tree[1]?.kind, "leaf");
  assert.equal(tree[1]?.kind === "leaf" ? tree[1].fullKeyDisplay : "", "x");

  const aGroup = tree[0];
  assert.equal(aGroup?.kind, "group");
  if (aGroup?.kind !== "group") return;

  assert.deepEqual(aGroup.pathSegments, ["a"]);
  assert.deepEqual(leafLabels(aGroup.children), ["e"]);

  const bGroup = aGroup.children.find((node) => node.kind === "group" && node.label === "b");
  assert.ok(bGroup);
  if (!bGroup || bGroup.kind !== "group") return;

  assert.deepEqual(
    bGroup.children.map((node) => (node.kind === "leaf" ? node.fullKeyDisplay : node.label)),
    ["a:b:c", "a:b:d"],
  );
});

test("buildRedisKeyTree preserves binary prefix segments from display text", () => {
  const tree = buildRedisKeyTree([makeKey("\\xac\\xed\\x00\\x05t\\x00token:work:app", "k1")], 2);

  assert.equal(tree.length, 1);
  const root = tree[0];
  assert.equal(root?.kind, "group");
  if (!root || root.kind !== "group") return;

  assert.equal(root.label, "\\xac\\xed\\x00\\x05t\\x00token");
  const work = root.children[0];
  assert.equal(work?.kind, "group");
  if (!work || work.kind !== "group") return;

  assert.equal(work.label, "work");
  const appLeaf = work.children[0];
  assert.equal(appLeaf?.kind, "leaf");
  if (!appLeaf || appLeaf.kind !== "leaf") return;
  assert.equal(appLeaf.label, "app");
  assert.equal(appLeaf.fullKeyDisplay, "\\xac\\xed\\x00\\x05t\\x00token:work:app");
});

test("collectExpandedGroupIds and flattenVisibleRedisKeyTree expand all search paths", () => {
  const tree = buildRedisKeyTree([makeKey("user:profile:name", "k1"), makeKey("user:settings", "k2")], 0);
  const expanded = collectExpandedGroupIds(tree);
  const rows = flattenVisibleRedisKeyTree(tree, expanded);

  assert.deepEqual(
    rows.map(({ node, depth }) => `${depth}:${node.kind}:${node.label}`),
    [
      "0:group:user",
      "1:group:profile",
      "2:leaf:name",
      "1:leaf:settings",
    ],
  );
});
