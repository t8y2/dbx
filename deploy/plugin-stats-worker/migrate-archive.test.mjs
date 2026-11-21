// Unit tests for the legacy -> single-document archive migration.
// Run: node --test deploy/plugin-stats-worker/migrate-archive.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { buildArchive, documentKey, verifyArchive } from "./migrate-archive.mjs";

const SAMPLE = new Map([
  ["total:inst:foo:1.0.0", "12"],
  ["total:inst:foo:1.1.0", "37"],
  ["total:updt:foo:1.1.0", "4"],
  ["total:dl:bar:0.2.0", "1034"],
  ["total:dl:bar", "1050"],
  ["uniqd:inst:foo:2026-11-09", "5"],
  ["uniqd:updt:foo:2026-11-09", "2"],
  ["meta:last-success", "2026-11-10 04:00:42"],
  ["summary", '{"inst":{"foo":49}}'],
  ["agg:tuning", "400"],
]);

test("documentKey strips the legacy prefix and ignores unrelated keys", () => {
  assert.deepEqual(documentKey("total:inst:foo:1.0.0"), { section: "total", key: "inst:foo:1.0.0" });
  assert.deepEqual(documentKey("uniqd:updt:foo:2026-11-09"), { section: "uniqd", key: "updt:foo:2026-11-09" });
  assert.equal(documentKey("summary"), null);
  assert.equal(documentKey("agg:lock"), null);
  assert.equal(documentKey("archive:v2"), null);
});

test("buildArchive copies every counter and the watermark", () => {
  const doc = buildArchive(SAMPLE);
  assert.equal(doc.v, 2);
  assert.equal(doc.lastSuccess, "2026-11-10 04:00:42");
  assert.deepEqual(doc.total, {
    "inst:foo:1.0.0": 12,
    "inst:foo:1.1.0": 37,
    "updt:foo:1.1.0": 4,
    "dl:bar:0.2.0": 1034,
    "dl:bar": 1050,
  });
  assert.deepEqual(doc.uniqd, { "inst:foo:2026-11-09": 5, "updt:foo:2026-11-09": 2 });
});

test("buildArchive keeps a missing watermark empty instead of inventing one", () => {
  const doc = buildArchive(new Map([["total:inst:foo:1.0.0", "1"]]));
  assert.equal(doc.lastSuccess, "");
});

test("buildArchive rejects a non-integer counter instead of dropping it", () => {
  assert.throws(() => buildArchive(new Map([["total:inst:foo:1.0.0", "12x"]])), /non-integer value/);
  assert.throws(() => buildArchive(new Map([["total:inst:foo:1.0.0", "-3"]])), /non-integer value/);
});

test("buildArchive accepts plugin rollups and rejects a key without a plugin", () => {
  assert.deepEqual(buildArchive(new Map([["total:inst:foo", "49"]])).total, { "inst:foo": 49 });
  assert.throws(() => buildArchive(new Map([["total:inst", "1"]])), /unexpected shape/);
});

test("verifyArchive accepts a faithful document", () => {
  assert.deepEqual(verifyArchive(buildArchive(SAMPLE), SAMPLE), []);
});

test("verifyArchive reports a missing counter", () => {
  const doc = buildArchive(SAMPLE);
  delete doc.total["inst:foo:1.1.0"];
  const problems = verifyArchive(doc, SAMPLE);
  assert.ok(problems.some((problem) => problem.includes("total: doc has")), problems.join("; "));
});

test("verifyArchive reports a wrong counter value", () => {
  const doc = buildArchive(SAMPLE);
  doc.uniqd["inst:foo:2026-11-09"] = 6;
  const problems = verifyArchive(doc, SAMPLE);
  assert.ok(problems.some((problem) => problem.includes("uniqd[inst:foo:2026-11-09]")), problems.join("; "));
});

test("verifyArchive reports a diverged watermark", () => {
  const doc = buildArchive(SAMPLE);
  doc.lastSuccess = "2026-11-10 05:00:00";
  const problems = verifyArchive(doc, SAMPLE);
  assert.ok(problems.some((problem) => problem.includes("lastSuccess mismatch")), problems.join("; "));
});
