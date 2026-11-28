// Unit tests for the archive document model in worker.ts.
// Run: node --test deploy/plugin-stats-worker/worker.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { applySummary, applyWindow, emptyArchive, parseArchive } from "./worker.ts";

const count = (kind, plugin, version, events) => ({ kind, plugin, version, events });
const unique = (kind, plugin, day, uniq) => ({ kind, plugin, day, uniq });

test("applyWindow advances the versioned counter and its plugin rollup together", () => {
  const doc = emptyArchive();
  applyWindow(doc, [count("inst", "foo", "1.0.0", 3)], []);
  assert.equal(doc.total["inst:foo:1.0.0"], 3);
  assert.equal(doc.total["inst:foo"], 3);
});

test("versions roll up to the plugin total across windows", () => {
  const doc = emptyArchive();
  applyWindow(doc, [count("inst", "foo", "1.0.0", 3), count("inst", "foo", "1.1.0", 4)], []);
  applyWindow(doc, [count("inst", "foo", "1.1.0", 5)], []);
  assert.equal(doc.total["inst:foo:1.0.0"], 3);
  assert.equal(doc.total["inst:foo:1.1.0"], 9);
  assert.equal(doc.total["inst:foo"], 12);
});

test("kinds stay separate", () => {
  const doc = emptyArchive();
  applyWindow(doc, [count("inst", "foo", "1.0.0", 2), count("updt", "foo", "1.0.0", 7)], []);
  assert.equal(doc.total["inst:foo"], 2);
  assert.equal(doc.total["updt:foo"], 7);
});

test("per-day uniques overwrite instead of adding", () => {
  const doc = emptyArchive();
  applyWindow(doc, [], [unique("inst", "foo", "2026-11-10", 5)]);
  applyWindow(doc, [], [unique("inst", "foo", "2026-11-10", 6)]);
  assert.equal(doc.uniqd["inst:foo:2026-11-10"], 6);
});

test("applySummary adds the same window per plugin", () => {
  const summary = { inst: { foo: 2 } };
  applySummary(summary, [count("inst", "foo", "1.1.0", 3), count("inst", "bar", "2.0.0", 1)]);
  assert.deepEqual(summary, { inst: { foo: 5, bar: 1 } });
});

test("parseArchive round-trips and rejects an unknown version", () => {
  const doc = emptyArchive();
  applyWindow(doc, [count("inst", "foo", "1.0.0", 1)], []);
  assert.deepEqual(parseArchive(JSON.stringify(doc)), doc);
  assert.throws(() => parseArchive(JSON.stringify({ ...doc, v: 3 })), /unsupported version/);
  assert.throws(() => parseArchive("null"), /not an object/);
});
