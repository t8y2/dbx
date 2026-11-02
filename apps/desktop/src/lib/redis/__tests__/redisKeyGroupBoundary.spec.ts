import { expect, it } from "vitest";
import { RedisKeyGroupIndex, findRedisOuterGroup } from "../redisKeyGroupIndex";

const work = { current: () => true, yield: async () => {} };
const rules = [
  { id: "a", name: "A", enabled: true, includes: ["a:*"], excludes: [] },
  { id: "empty", name: "Empty", enabled: true, includes: ["missing:*"], excludes: [] },
];
const key = (name: string) => ({ key_raw: btoa(name), key_display: name, key_type: "string", ttl: -1 });

it.each(["list", "tree"] as const)("captures atomic outer boundaries for %s, excluding namespace headers", async (view) => {
  const index = new RedisKeyGroupIndex(rules, "Unmatched");
  await index.append([key("a:1"), key("a:2"), key("b:1")], work);
  const expanded = new Set(['custom:"a"', 'custom:"a":namespace:["a"]', "custom:unmatched"]);
  const first = (await index.project(view, ":", expanded, work))!;
  expect(first.outerGroups).toHaveLength(3);
  expect(first.outerGroups.map((group) => group.row.label)).toEqual(["A", "Empty", "Unmatched"]);
  for (const group of first.outerGroups) {
    expect(first.rows[group.start]).toBe(group.row);
    expect(findRedisOuterGroup(first.outerGroups, group.start)).toBe(group);
    expect(findRedisOuterGroup(first.outerGroups, group.end - 0.1)).toBe(group);
  }
  expect(findRedisOuterGroup(first.outerGroups, -1)).toBeUndefined();
  expect(findRedisOuterGroup(first.outerGroups, first.rows.length)).toBeUndefined();
  const before = first.outerGroups.map((group) => ({ ...group }));
  await index.append([key("a:1"), key("a:2"), key("b:1"), key("a:3")], work);
  const collapsed = (await index.project(view, ":", new Set(), work))!;
  expect(collapsed.outerGroups.map((group) => group.end - group.start)).toEqual([1, 1, 1]);
  expect(first.outerGroups).toEqual(before);
  expect(first.outerGroups[0]!.row.count).toBe(2);
  expect(collapsed.outerGroups[0]!.row.count).toBe(3);
});

it("keeps million-key boundary storage bounded by groups, including unmatched", async () => {
  const index = new RedisKeyGroupIndex(rules, "Unmatched");
  const keys = Array.from({ length: 1_000_000 }, (_, n) => key(`a:${n}`));
  await index.append(keys, work);
  const snapshot = (await index.project("list", ":", new Set(['custom:"a"']), work))!;
  expect(snapshot.rows.length).toBe(1_000_002);
  expect(snapshot.outerGroups).toHaveLength(2);
  expect(findRedisOuterGroup(snapshot.outerGroups, 999_999)?.row.id).toBe('custom:"a"');
  expect(findRedisOuterGroup(snapshot.outerGroups, 1_000_001)?.row.label).toBe("Empty");
});
