import { expect, it } from "vitest";
import { findRedisHeaderChain, RedisKeyGroupIndex } from "../redisKeyGroupIndex";
import { redisStickyHeaders, redisStickyHeight } from "../redisStickyHeaders";

const work = { current: () => true, yield: async () => {} };
async function fixture() {
  const index = new RedisKeyGroupIndex([], "Unmatched");
  await index.append(
    Array.from({ length: 1000 }, (_, n) => ({ key_display: `a:b:c:d:${n}`, key_raw: btoa(`a:b:c:d:${n}`), ttl: -1, key_type: "string" })),
    work,
  );
  const expanded = new Set(["custom:unmatched"]);
  for (const path of [["a"], ["a", "b"], ["a", "b", "c"], ["a", "b", "c", "d"]]) expanded.add(`custom:unmatched:namespace:${JSON.stringify(path)}`);
  return { index, expanded, snapshot: (await index.project("tree", ":", expanded, work))! };
}

it("indexes ancestry once per header, with atomic end ranges and no leaf access during lookup", async () => {
  const { index, expanded, snapshot } = await fixture();
  expect(snapshot.headerBoundaries).toHaveLength(5);
  let reads = 0;
  const headers = new Proxy(snapshot.headerBoundaries, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) reads++;
      return Reflect.get(target, prop, receiver);
    },
  });
  expect(findRedisHeaderChain(headers, 999).map((header) => header.row.label)).toEqual(["Unmatched", "a", "b", "c", "d"]);
  expect(reads).toBeLessThanOrEqual(5);
  expanded.delete('custom:unmatched:namespace:["a","b"]');
  const collapsed = (await index.project("tree", ":", expanded, work))!;
  expect(collapsed.headerBoundaries).toHaveLength(3);
  expect(snapshot.headerBoundaries[0]!.end).toBe(1005);
  expect(findRedisHeaderChain(collapsed.headerBoundaries, 3)).toEqual([]);
});

it("bounds height at zero, one, two and three rows and indicates omitted ancestors", async () => {
  const { snapshot } = await fixture();
  const sticky = (height: number, scroll = 500) => redisStickyHeaders(snapshot.outerGroups, snapshot.headerBoundaries, scroll, height, true);
  expect(sticky(99)).toEqual([]);
  expect(sticky(100).map((entry) => entry.row.label)).toEqual(["Unmatched"]);
  expect(sticky(200).map((entry) => entry.row.label)).toEqual(["Unmatched", "d"]);
  expect(sticky(300).map((entry) => entry.row.label)).toEqual(["Unmatched", "c", "d"]);
  expect(sticky(300)[1]!.omitted).toBe(true);
  expect(sticky(300)[1]!.path).toBe("Unmatched › a › b › c › d");
  expect(redisStickyHeight(sticky(1000))).toBe(90);
  expect(sticky(300, 0)).toEqual([]);
  expect(redisStickyHeaders(snapshot.outerGroups, snapshot.headerBoundaries, 500, 99, false)).toHaveLength(1);
});

it("retains expanded parents above a collapsed current namespace before compressing", async () => {
  const { index, expanded } = await fixture();
  expanded.delete('custom:unmatched:namespace:["a","b","c","d"]');
  const snapshot = (await index.project("tree", ":", expanded, work))!;
  expect(redisStickyHeaders(snapshot.outerGroups, snapshot.headerBoundaries, 60, 300, true).map((entry) => entry.row.label)).toEqual(["Unmatched", "b", "c"]);
});

it("pushes the outgoing sibling behind its parents and never pins the incoming natural header twice", async () => {
  const index = new RedisKeyGroupIndex([], "Unmatched");
  await index.append(
    ["a", "b"].flatMap((branch) => Array.from({ length: 10 }, (_, n) => ({ key_display: `p:${branch}:${n}`, key_raw: btoa(`p:${branch}:${n}`), ttl: -1, key_type: "string" }))),
    work,
  );
  const expanded = new Set(["custom:unmatched", 'custom:unmatched:namespace:["p"]', 'custom:unmatched:namespace:["p","a"]', 'custom:unmatched:namespace:["p","b"]']);
  const snapshot = (await index.project("tree", ":", expanded, work))!;
  const b = snapshot.headerBoundaries.find((header) => header.row.label === "b")!;
  const before = redisStickyHeaders(snapshot.outerGroups, snapshot.headerBoundaries, b.start * 30 - 75, 300, true);
  expect(before.map((entry) => entry.row.label)).toEqual(["Unmatched", "p", "a"]);
  expect(before[2]!.top).toBe(45);
  expect(redisStickyHeight(before)).toBe(75);
  const aligned = redisStickyHeaders(snapshot.outerGroups, snapshot.headerBoundaries, b.start * 30 - 60, 300, true);
  expect(aligned.map((entry) => entry.row.label)).toEqual(["Unmatched", "p"]);
  const after = redisStickyHeaders(snapshot.outerGroups, snapshot.headerBoundaries, b.start * 30 - 59, 300, true);
  expect(after.map((entry) => entry.row.label)).toEqual(["Unmatched", "p", "b"]);
});
