// Unit tests for the rollup repair.
// Run: node --test deploy/plugin-stats-worker/reconcile-rollups.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { reconcileRollups, splitCounterKey, verifyRollups } from "./reconcile-rollups.mjs";

const doc = (total) => ({ v: 2, lastSuccess: "2026-11-17 04:00:42", total, uniqd: {} });

test("splitCounterKey distinguishes rollups from versioned counters", () => {
  assert.equal(splitCounterKey("dl:foo").isRollup, true);
  assert.equal(splitCounterKey("dl:foo:1.0.0").isRollup, false);
});

test("raises a stale rollup to the version sum", () => {
  const d = doc({ "dl:foo": 10, "dl:foo:1.0.0": 7, "dl:foo:1.1.0": 8 });
  const { changes } = reconcileRollups(d);
  assert.equal(d.total["dl:foo"], 15);
  assert.deepEqual(changes[0], { key: "dl:foo", from: 10, to: 15, kind: "raised" });
});

test("creates a missing rollup", () => {
  const d = doc({ "inst:bar:2.0.0": 4 });
  const { created } = reconcileRollups(d);
  assert.equal(created, 1);
  assert.equal(d.total["inst:bar"], 4);
});

test("never lowers a rollup that is already ahead of its versions", () => {
  const d = doc({ "inst:foo": 8, "inst:foo:1.0.0": 7 });
  const { changes } = reconcileRollups(d);
  assert.equal(d.total["inst:foo"], 8);
  assert.deepEqual(changes, []);
});

test("leaves an already-correct rollup untouched", () => {
  const d = doc({ "dl:foo": 15, "dl:foo:1.0.0": 7, "dl:foo:1.1.0": 8 });
  const { changes, unchanged } = reconcileRollups(d);
  assert.deepEqual(changes, []);
  assert.equal(unchanged, 1);
});

test("verifyRollups reports a short or missing rollup", () => {
  const short = doc({ "dl:foo": 3, "dl:foo:1.0.0": 7 });
  assert.match(verifyRollups(short)[0], /rollup 3 < version sum 7/);
  const missing = doc({ "dl:foo:1.0.0": 7 });
  assert.match(verifyRollups(missing)[0], /no rollup/);
});

test("verifyRollups accepts the repaired document", () => {
  const d = doc({ "dl:foo": 10, "dl:foo:1.0.0": 7, "dl:foo:1.1.0": 8 });
  reconcileRollups(d);
  assert.deepEqual(verifyRollups(d), []);
});
