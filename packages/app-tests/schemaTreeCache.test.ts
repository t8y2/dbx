import assert from "node:assert/strict";
import { test } from "vitest";
import { SCHEMA_TREE_CACHE_TTL_MS, decodeSchemaTreeCache, encodeSchemaTreeCache } from "../../apps/desktop/src/lib/schemaTreeCache.ts";

const children = [{ id: "conn:db", label: "db", type: "database" }];
const now = Date.parse("2026-05-17T10:00:00.000Z");

test("wraps tree children with a cache timestamp", () => {
  assert.deepEqual(encodeSchemaTreeCache(children, now), {
    version: 2,
    cachedAt: "2026-05-17T10:00:00.000Z",
    children,
  });
});

test("treats recent schema tree cache envelopes as fresh", () => {
  const payload = encodeSchemaTreeCache(children, now);

  assert.deepEqual(decodeSchemaTreeCache(payload, now + SCHEMA_TREE_CACHE_TTL_MS - 1), {
    children,
    isStale: false,
  });
});

test("treats expired schema tree cache envelopes as stale", () => {
  const payload = encodeSchemaTreeCache(children, now);

  assert.deepEqual(decodeSchemaTreeCache(payload, now + SCHEMA_TREE_CACHE_TTL_MS + 1), {
    children,
    isStale: true,
  });
});

test("keeps legacy array cache readable but stale", () => {
  assert.deepEqual(decodeSchemaTreeCache(children, now), {
    children,
    isStale: true,
  });
});

test("rejects invalid schema tree cache payloads", () => {
  assert.equal(decodeSchemaTreeCache({ version: 2, cachedAt: "bad", children: "nope" }, now), null);
  assert.equal(decodeSchemaTreeCache({ version: 1, cachedAt: "2026-05-17T10:00:00.000Z", children }, now), null);
});
