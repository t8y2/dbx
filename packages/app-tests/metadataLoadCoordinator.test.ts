import assert from "node:assert/strict";
import { test } from "vitest";
import { createMetadataLoadTrace, MetadataLoadCoordinator } from "../../apps/desktop/src/lib/metadata/metadataLoadCoordinator.ts";
import { metadataScopeKey } from "../../apps/desktop/src/lib/metadata/metadataLoadScope.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("metadata scope key treats equivalent object type sets as equal", () => {
  const left = metadataScopeKey({
    kind: "object-group",
    connectionId: "conn",
    database: "app",
    schema: "public",
    nodeKind: "group-tables",
    objectTypes: ["view", "TABLE", "TABLE"],
    searchFilter: "  user  ",
    limit: 501,
    offset: 0,
    sidebarDisplayMode: "grouped",
    driverProfile: "postgres",
  });
  const right = metadataScopeKey({
    kind: "object-group",
    connectionId: "conn",
    database: "app",
    schema: "public",
    nodeKind: "group-tables",
    objectTypes: ["TABLE", "VIEW"],
    searchFilter: "user",
    limit: 501,
    offset: 0,
    sidebarDisplayMode: "grouped",
    driverProfile: "postgres",
  });

  assert.equal(left, right);
});

test("metadata scope key separates result-affecting fields", () => {
  const base = {
    kind: "sidebar-table-search",
    connectionId: "conn",
    database: "app",
    schema: "public",
    objectTypes: ["TABLE"],
    limit: 500,
    offset: 0,
    sidebarDisplayMode: "simple",
    driverProfile: "postgres",
  };

  assert.notEqual(metadataScopeKey({ ...base, searchFilter: "user" }), metadataScopeKey({ ...base, searchFilter: "order" }));
  assert.notEqual(metadataScopeKey({ ...base, offset: 0 }), metadataScopeKey({ ...base, offset: 500 }));
  assert.notEqual(metadataScopeKey({ ...base, objectTypes: ["TABLE"] }), metadataScopeKey({ ...base, objectTypes: ["VIEW"] }));
  assert.notEqual(metadataScopeKey({ ...base, sidebarDisplayMode: "simple" }), metadataScopeKey({ ...base, sidebarDisplayMode: "grouped" }));
});

test("metadata load coordinator deduplicates equivalent in-flight loads", async () => {
  const events: string[] = [];
  const coordinator = new MetadataLoadCoordinator((event) => events.push(event.event));
  const gate = deferred<string>();
  let calls = 0;
  const scope = { kind: "database-schemas", connectionId: "conn", database: "app", driverProfile: "postgres" };
  const first = coordinator.run(scope, async () => {
    calls++;
    return gate.promise;
  });
  const second = coordinator.run(scope, async () => {
    calls++;
    return "unexpected";
  });

  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.deepEqual(events.slice(0, 2), ["start", "dedupe"]);

  gate.resolve("schemas");
  assert.equal(await first, "schemas");
  assert.equal(await second, "schemas");
  assert.equal(coordinator.has(scope), false);
});

test("metadata load coordinator keeps different filters independent", async () => {
  const coordinator = new MetadataLoadCoordinator();
  const first = deferred<string>();
  const second = deferred<string>();
  let calls = 0;

  const user = coordinator.run({ kind: "sidebar-table-search", connectionId: "conn", database: "app", schema: "public", searchFilter: "user" }, async () => {
    calls++;
    return first.promise;
  });
  const order = coordinator.run({ kind: "sidebar-table-search", connectionId: "conn", database: "app", schema: "public", searchFilter: "order" }, async () => {
    calls++;
    return second.promise;
  });

  await Promise.resolve();
  assert.equal(calls, 2);
  first.resolve("users");
  second.resolve("orders");
  assert.deepEqual(await Promise.all([user, order]), ["users", "orders"]);
});

test("metadata load coordinator force bypasses in-flight reuse", async () => {
  const coordinator = new MetadataLoadCoordinator();
  const slow = deferred<string>();
  let calls = 0;
  const scope = { kind: "connection-databases", connectionId: "conn" };
  const normal = coordinator.run(scope, async () => {
    calls++;
    return slow.promise;
  });
  const forced = coordinator.run(
    scope,
    async () => {
      calls++;
      return "fresh";
    },
    { force: true },
  );

  assert.equal(await forced, "fresh");
  assert.equal(calls, 2);
  slow.resolve("cached");
  assert.equal(await normal, "cached");
});

test("metadata load trace reports scope, elapsed time, cache and request state", () => {
  let now = 100;
  const trace = createMetadataLoadTrace(
    {
      kind: "table-metadata",
      connectionId: "conn",
      database: "app",
      schema: "public",
      tableName: "users",
    },
    { traceId: "trace-1", now: () => now },
  );

  now = 137;
  assert.deepEqual(trace.event("done", { cacheStatus: "stale", resultCount: 12, deduped: true, superseded: false }), {
    event: "done",
    traceId: "trace-1",
    scopeKey: metadataScopeKey({
      kind: "table-metadata",
      connectionId: "conn",
      database: "app",
      schema: "public",
      tableName: "users",
    }),
    elapsedMs: 37,
    cacheStatus: "stale",
    resultCount: 12,
    deduped: true,
    superseded: false,
  });
});
