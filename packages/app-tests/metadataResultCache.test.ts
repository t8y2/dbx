import assert from "node:assert/strict";
import { test } from "vitest";
import { MetadataResultCache } from "../../apps/desktop/src/lib/metadata/metadataResultCache.ts";

test("metadata result cache returns fresh hits and exposes stale hits when requested", () => {
  let now = 1_000;
  const cache = new MetadataResultCache<string>({ ttlMs: 50, maxEntries: 10, now: () => now });
  const scope = { kind: "table-list-page", connectionId: "conn", database: "app", schema: "public", limit: 501, offset: 0 };

  cache.set(scope, "tables");
  assert.equal(cache.get(scope)?.value, "tables");

  now = 1_100;
  assert.equal(cache.get(scope), undefined);
  const stale = cache.get(scope, { allowStale: true });
  assert.equal(stale?.value, "tables");
  assert.equal(stale?.stale, true);
  assert.equal(stale?.ageMs, 100);
});

test("metadata result cache invalidates affected scopes without clearing unrelated databases", () => {
  const cache = new MetadataResultCache<string>({ ttlMs: 30_000, maxEntries: 10, now: () => 1 });
  const publicTables = { kind: "table-list-page", connectionId: "conn", database: "app", schema: "public", objectTypes: ["VIEW", "TABLE"], limit: 501, offset: 0 };
  const auditTables = { kind: "table-list-page", connectionId: "conn", database: "app", schema: "audit", objectTypes: ["TABLE"], limit: 501, offset: 0 };
  const otherDatabase = { kind: "table-list-page", connectionId: "conn", database: "other", schema: "public", objectTypes: ["TABLE"], limit: 501, offset: 0 };
  const otherConnection = { kind: "table-list-page", connectionId: "other", database: "app", schema: "public", objectTypes: ["TABLE"], limit: 501, offset: 0 };

  cache.set(publicTables, "public");
  cache.set(auditTables, "audit");
  cache.set(otherDatabase, "other-db");
  cache.set(otherConnection, "other-conn");

  assert.equal(cache.invalidate({ connectionId: "conn", database: "app", schema: "public" }), 1);
  assert.equal(cache.get(publicTables), undefined);
  assert.equal(cache.get(auditTables)?.value, "audit");
  assert.equal(cache.get(otherDatabase)?.value, "other-db");
  assert.equal(cache.get(otherConnection)?.value, "other-conn");
});

test("metadata result cache evicts least recently used entries", () => {
  const cache = new MetadataResultCache<string>({ ttlMs: 30_000, maxEntries: 2, now: () => 1 });
  const first = { kind: "object-list-page", connectionId: "conn", database: "app", schema: "public", nodeKind: "group-functions" };
  const second = { kind: "object-list-page", connectionId: "conn", database: "app", schema: "audit", nodeKind: "group-functions" };
  const third = { kind: "object-list-page", connectionId: "conn", database: "other", schema: "public", nodeKind: "group-functions" };

  cache.set(first, "first");
  cache.set(second, "second");
  assert.equal(cache.get(first)?.value, "first");
  cache.set(third, "third");

  assert.equal(cache.get(first)?.value, "first");
  assert.equal(cache.get(second), undefined);
  assert.equal(cache.get(third)?.value, "third");
});
