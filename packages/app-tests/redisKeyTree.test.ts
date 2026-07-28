import { test } from "vitest";
import assert from "node:assert/strict";
import {
  appendRedisKeysToTreeIndex,
  buildRedisKeyTree,
  canBuildRedisFuzzyTree,
  collectRedisGroupKeyRaws,
  collectExpandedGroupIds,
  createRedisKeyTreeIndex,
  flattenVisibleRedisKeyTree,
  mergeKeysIntoRedisKeyTree,
  redisKeyNameCopyText,
  redisKeyToFlatTreeRow,
  REDIS_FUZZY_TREE_MAX_KEYS,
  type RedisKeyTreeGroupNode,
  type RedisKeyTreeNode,
} from "../../apps/desktop/src/lib/redis/redisKeyTree.ts";
import type { RedisKeyInfo } from "../../apps/desktop/src/lib/backend/api.ts";

function makeKey(key_display: string, key_raw: string, key_type = "string", ttl = -1): RedisKeyInfo {
  return { key_display, key_raw, key_type, ttl };
}

function leafLabels(nodes: RedisKeyTreeNode[]): string[] {
  return nodes.filter((node) => node.kind === "leaf").map((node) => node.label);
}

function findGroup(nodes: RedisKeyTreeNode[], label: string): RedisKeyTreeGroupNode {
  const group = nodes.find((node) => node.kind === "group" && node.label === label);
  assert.ok(group);
  assert.equal(group.kind, "group");
  return group;
}

test("fuzzy hierarchy stops before the configured key limit is exceeded", () => {
  assert.equal(canBuildRedisFuzzyTree(REDIS_FUZZY_TREE_MAX_KEYS), true);
  assert.equal(canBuildRedisFuzzyTree(REDIS_FUZZY_TREE_MAX_KEYS + 1), false);
});

test("buildRedisKeyTree groups colon-delimited keys by segment", () => {
  const tree = buildRedisKeyTree([makeKey("a:b:c", "k1"), makeKey("a:b:d", "k2"), makeKey("a:e", "k3"), makeKey("x", "k4")], 0);

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
  assert.ok(rows.every((row) => row.id === row.node.id));
});

test("flattenVisibleRedisKeyTree handles very large expanded groups without stack overflow", () => {
  const keys = Array.from({ length: 150_000 }, (_, index) => {
    const id = String(index).padStart(6, "0");
    return makeKey(`user:${id}`, `user:${id}`);
  });
  const tree = buildRedisKeyTree(keys, 0);
  const expanded = collectExpandedGroupIds(tree);

  const rows = flattenVisibleRedisKeyTree(tree, expanded);

  assert.equal(rows.length, keys.length + 1);
  assert.equal(rows[0]?.node.kind, "group");
  assert.equal(rows[0]?.node.label, "user");
  assert.equal(rows[1]?.depth, 1);
  assert.equal(rows.at(-1)?.depth, 1);
  assert.ok(rows.every((row) => row.id === row.node.id));
});

test("redisKeyToFlatTreeRow keeps search results flat with the full key label", () => {
  const row = redisKeyToFlatTreeRow(makeKey("user:profile:1", "user:profile:1", ""), 0);

  assert.equal(row.depth, 0);
  assert.equal(row.id, row.node.id);
  assert.equal(row.node.kind, "leaf");
  if (row.node.kind !== "leaf") return;
  assert.equal(row.node.label, "user:profile:1");
  assert.deepEqual(row.node.pathSegments, ["user:profile:1"]);
  assert.equal(row.node.keyType, "");
});

test("redisKeyNameCopyText uses the display name instead of raw encoding", () => {
  const tree = buildRedisKeyTree([makeKey("user:profile:1", "dXNlcjpwcm9maWxlOjE=")], 0);
  const userGroup = tree[0];
  assert.equal(userGroup?.kind, "group");
  if (!userGroup || userGroup.kind !== "group") return;

  assert.equal(redisKeyNameCopyText(userGroup), null);
  const profileGroup = userGroup.children[0];
  assert.equal(profileGroup?.kind, "group");
  if (!profileGroup || profileGroup.kind !== "group") return;

  const leaf = profileGroup.children[0];
  assert.equal(leaf?.kind, "leaf");
  if (!leaf || leaf.kind !== "leaf") return;
  assert.equal(redisKeyNameCopyText(leaf), "user:profile:1");
  assert.notEqual(redisKeyNameCopyText(leaf), leaf.keyRaw);
});

test("collectRedisGroupKeyRaws returns every leaf key under a group", () => {
  const tree = buildRedisKeyTree([makeKey("user:profile:name", "k1"), makeKey("user:profile:email", "k2"), makeKey("user:settings", "k3"), makeKey("session:1", "k4")], 0);

  const userGroup = tree.find((node) => node.kind === "group" && node.label === "user");
  assert.ok(userGroup);
  if (!userGroup || userGroup.kind !== "group") return;

  assert.deepEqual(collectRedisGroupKeyRaws(userGroup), ["k2", "k1", "k3"]);
});

test("group identity keeps NUL-containing path segments isolated", () => {
  const firstKeyRaw = "raw-first";
  const secondKeyRaw = "raw-second";
  const index = createRedisKeyTreeIndex([makeKey(`a\0b:c:x`, firstKeyRaw), makeKey(`a:b\0c:y`, secondKeyRaw)], 0);

  const firstRoot = findGroup(index.root, `a\0b`);
  const firstBranch = findGroup(firstRoot.children, "c");
  const secondRoot = findGroup(index.root, "a");
  const secondBranch = findGroup(secondRoot.children, `b\0c`);

  assert.notEqual(firstBranch.id, secondBranch.id);
  assert.equal(index.groupById.size, 4);
  assert.deepEqual(collectRedisGroupKeyRaws(firstRoot), [firstKeyRaw]);
  assert.deepEqual(collectRedisGroupKeyRaws(secondRoot), [secondKeyRaw]);
  assert.deepEqual(index.ancestorGroupIdsByKeyRaw.get(firstKeyRaw), [firstRoot.id, firstBranch.id]);
  assert.deepEqual(index.ancestorGroupIdsByKeyRaw.get(secondKeyRaw), [secondRoot.id, secondBranch.id]);
});

test("tree index incrementally merges SCAN pages with loaded counts and selection ancestry", () => {
  const index = createRedisKeyTreeIndex([makeKey("team:api:v1", "k1"), makeKey("team:web:home", "k2")], 0);
  const team = findGroup(index.root, "team");
  const api = findGroup(team.children, "api");

  const { addedGroupIds } = appendRedisKeysToTreeIndex(
    index,
    [
      makeKey("team:api:v2", "k3"),
      makeKey("orders:1", "k4"),
      // SCAN may return the same key more than once across pages.
      makeKey("team:api:v1", "k1"),
    ],
    0,
  );

  const orders = findGroup(index.root, "orders");
  assert.deepEqual(
    index.root.map((node) => node.label),
    ["orders", "team"],
  );
  assert.equal(team.loadedLeafCount, 3);
  assert.equal(api.loadedLeafCount, 2);
  assert.equal(orders.loadedLeafCount, 1);
  assert.equal(index.keyRaws.size, 4);
  assert.deepEqual(index.ancestorGroupIdsByKeyRaw.get("k3"), [team.id, api.id]);
  assert.ok(addedGroupIds.has(orders.id));
  assert.ok(!addedGroupIds.has(team.id));
  assert.deepEqual(collectRedisGroupKeyRaws(team), ["k1", "k3", "k2"]);
});

test("buildRedisKeyTree honors custom and empty Redis key separators", () => {
  const customSeparatorTree = buildRedisKeyTree([makeKey("service/api/v1", "k1"), makeKey("service/web", "k2"), makeKey("literal:colon", "k3")], 0, "/");
  const service = findGroup(customSeparatorTree, "service");
  const api = findGroup(service.children, "api");

  assert.equal(service.loadedLeafCount, 2);
  assert.equal(api.loadedLeafCount, 1);
  assert.deepEqual(collectRedisGroupKeyRaws(service), ["k1", "k2"]);
  assert.deepEqual(
    buildRedisKeyTree([makeKey("service/api/v1", "k1"), makeKey("literal:colon", "k2")], 0, "").map((node) => `${node.kind}:${node.label}`),
    ["leaf:literal:colon", "leaf:service/api/v1"],
  );
});

test("tree keeps a namespace leaf alongside its child group", () => {
  const tree = buildRedisKeyTree([makeKey("session", "k1"), makeKey("session:active", "k2")], 0);
  const sessionGroup = findGroup(tree, "session");

  assert.equal(sessionGroup.loadedLeafCount, 1);
  assert.deepEqual(
    tree.map((node) => `${node.kind}:${node.label}`),
    ["group:session", "leaf:session"],
  );
  assert.deepEqual(collectRedisGroupKeyRaws(sessionGroup), ["k2"]);
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

  const toStr = (nodes: RedisKeyTreeNode[]): string => JSON.stringify(nodes.map((node) => node.label));

  assert.equal(toStr(merged), toStr(full));
});
