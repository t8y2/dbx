import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRedisKeyTree,
  collectRedisGroupKeyRaws,
  collectExpandedGroupIds,
  flattenVisibleRedisKeyTree,
  mergeKeysIntoRedisKeyTree,
  type RedisKeyTreeNode,
} from "../../apps/desktop/src/lib/redisKeyTree.ts";
import type { RedisKeyInfo } from "../../apps/desktop/src/lib/api.ts";

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
    ["0:group:user", "1:group:profile", "2:leaf:name", "1:leaf:settings"],
  );
});

test("collectRedisGroupKeyRaws returns every leaf key under a group", () => {
  const tree = buildRedisKeyTree(
    [
      makeKey("user:profile:name", "k1"),
      makeKey("user:profile:email", "k2"),
      makeKey("user:settings", "k3"),
      makeKey("session:1", "k4"),
    ],
    0,
  );

  const userGroup = tree.find((node) => node.kind === "group" && node.label === "user");
  assert.ok(userGroup);
  if (!userGroup || userGroup.kind !== "group") return;

  assert.deepEqual(collectRedisGroupKeyRaws(userGroup), ["k2", "k1", "k3"]);
});

test("mergeKeysIntoRedisKeyTree adds new leaf to existing group", () => {
  const tree = buildRedisKeyTree([makeKey("user:profile:name", "k1")], 0);
  const merged = mergeKeysIntoRedisKeyTree(tree, [makeKey("user:profile:email", "k2")], 0);

  const userGroup = merged.find((node) => node.kind === "group" && node.label === "user");
  assert.ok(userGroup);
  if (!userGroup || userGroup.kind !== "group") return;

  const profileGroup = userGroup.children.find((node) => node.kind === "group" && node.label === "profile");
  assert.ok(profileGroup);
  if (!profileGroup || profileGroup.kind !== "group") return;

  assert.equal(profileGroup.children.length, 2);
  const labels = profileGroup.children.map((node) => (node.kind === "leaf" ? node.label : ""));
  assert.deepEqual(labels, ["email", "name"]);
});

test("mergeKeysIntoRedisKeyTree creates new group for new prefix", () => {
  const tree = buildRedisKeyTree([makeKey("user:profile:name", "k1")], 0);
  const merged = mergeKeysIntoRedisKeyTree(tree, [makeKey("session:1", "k2")], 0);

  assert.equal(merged.length, 2);
  const labels = merged.map((node) => node.label);
  assert.deepEqual(labels, ["session", "user"]);
});

test("mergeKeysIntoRedisKeyTree handles root-level keys", () => {
  const tree = buildRedisKeyTree([makeKey("user:profile:name", "k1")], 0);
  const merged = mergeKeysIntoRedisKeyTree(tree, [makeKey("standalone", "k2")], 0);

  assert.equal(merged.length, 2);
  const rootLeaf = merged.find((node) => node.kind === "leaf");
  assert.ok(rootLeaf);
  if (!rootLeaf || rootLeaf.kind !== "leaf") return;
  assert.equal(rootLeaf.label, "standalone");
});

test("mergeKeysIntoRedisKeyTree returns same result as full build", () => {
  const batch1 = [makeKey("a:b:c", "k1"), makeKey("a:d", "k2")];
  const batch2 = [makeKey("a:b:e", "k3"), makeKey("x", "k4")];

  const tree = buildRedisKeyTree(batch1, 0);
  const merged = mergeKeysIntoRedisKeyTree(tree, batch2, 0);
  const full = buildRedisKeyTree([...batch1, ...batch2], 0);

  const toStr = (nodes: RedisKeyTreeNode[]): string =>
    JSON.stringify(
      nodes.map((node) => {
        if (node.kind === "leaf") return { l: node.label, id: node.id };
        return { g: node.label, id: node.id, c: toStr(node.children) };
      }),
    );

  assert.equal(toStr(merged), toStr(full));
});

test("mergeKeysIntoRedisKeyTree skips duplicate keys", () => {
  const tree = buildRedisKeyTree([makeKey("user:profile:name", "k1")], 0);
  const merged = mergeKeysIntoRedisKeyTree(tree, [makeKey("user:profile:name", "k1")], 0);

  const userGroup = merged[0];
  assert.ok(userGroup && userGroup.kind === "group");
  if (!userGroup || userGroup.kind !== "group") return;

  const profileGroup = userGroup.children[0];
  assert.ok(profileGroup && profileGroup.kind === "group");
  if (!profileGroup || profileGroup.kind !== "group") return;

  assert.equal(profileGroup.children.length, 1);
});

test("mergeKeysIntoRedisKeyTree into empty tree falls back to full build", () => {
  const merged = mergeKeysIntoRedisKeyTree([], [makeKey("a:b:c", "k1"), makeKey("x", "k2")], 0);
  const full = buildRedisKeyTree([makeKey("a:b:c", "k1"), makeKey("x", "k2")], 0);

  const toStr = (nodes: RedisKeyTreeNode[]): string =>
    JSON.stringify(nodes.map((node) => node.label));

  assert.equal(toStr(merged), toStr(full));
});
