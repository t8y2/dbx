import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildTabResultSnapshot, decodeTabResultSnapshot, encodeTabResultSnapshot } from "../../apps/desktop/src/lib/tabs/tabResultCache.ts";
import type { QueryResult, QueryTab } from "../../apps/desktop/src/types/database.ts";

function queryTab(overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id: "tab-1",
    title: "Query 1",
    connectionId: "conn-1",
    database: "app",
    sql: "select * from users",
    isExecuting: false,
    mode: "query",
    ...overrides,
  };
}

test("result snapshots strip live session handles and clone result rows", () => {
  const tab = queryTab({
    result: {
      columns: ["id"],
      rows: [[1]],
      mongo_documents: [{ _id: "1", profile: { role: "admin" } }],
      mongo_copy_documents: [{ _id: { $oid: "507f1f77bcf86cd799439011" }, createdAt: { $date: "2026-07-24T00:00:00Z" } }],
      affected_rows: 0,
      execution_time_ms: 1,
      session_id: "live-session",
      sourceLabel: "public.users",
      sourceStatement: "select * from public.users",
    },
    results: [
      {
        columns: ["id"],
        rows: [[1]],
        affected_rows: 0,
        execution_time_ms: 1,
        session_id: "live-session",
      },
    ],
    activeResultIndex: 0,
    resultLocalSortOriginalRows: [[2]],
    resultLocalSortOriginalMongoDocuments: [{ _id: "2", profile: { role: "maintainer" } }],
    resultLocalSortOriginalMongoCopyDocuments: [{ _id: { $oid: "507f1f77bcf86cd799439012" }, counter: { $numberLong: "9007199254740993" } }],
  });

  const snapshot = buildTabResultSnapshot(tab);

  assert.equal(snapshot?.result?.session_id, undefined);
  assert.equal(snapshot?.result?.sourceLabel, "public.users");
  assert.equal(snapshot?.result?.sourceStatement, "select * from public.users");
  assert.equal(snapshot?.results?.[0]?.session_id, undefined);
  assert.deepEqual(snapshot?.result?.rows, [[1]]);
  assert.deepEqual(snapshot?.result?.mongo_documents, [{ _id: "1", profile: { role: "admin" } }]);
  assert.deepEqual(snapshot?.result?.mongo_copy_documents, [{ _id: { $oid: "507f1f77bcf86cd799439011" }, createdAt: { $date: "2026-07-24T00:00:00Z" } }]);
  assert.deepEqual(snapshot?.resultLocalSortOriginalRows, [[2]]);
  assert.deepEqual(snapshot?.resultLocalSortOriginalMongoDocuments, [{ _id: "2", profile: { role: "maintainer" } }]);
  assert.deepEqual(snapshot?.resultLocalSortOriginalMongoCopyDocuments, [{ _id: { $oid: "507f1f77bcf86cd799439012" }, counter: { $numberLong: "9007199254740993" } }]);
  tab.result!.rows[0]![0] = 2;
  (tab.result!.mongo_copy_documents![0] as { createdAt: { $date: string } }).createdAt.$date = "changed";
  tab.resultLocalSortOriginalRows![0]![0] = 3;
  assert.deepEqual(snapshot?.result?.rows, [[1]]);
  assert.deepEqual(snapshot?.result?.mongo_copy_documents, [{ _id: { $oid: "507f1f77bcf86cd799439011" }, createdAt: { $date: "2026-07-24T00:00:00Z" } }]);
  assert.deepEqual(snapshot?.resultLocalSortOriginalRows, [[2]]);
});

test("result snapshots strip session handles from result runs", () => {
  const tab = queryTab({
    resultRuns: [
      {
        id: "run-1",
        title: "Run 1",
        sequence: 1,
        sql: "select 1",
        createdAt: 1,
        result: {
          columns: ["id"],
          rows: [[1]],
          mongo_copy_documents: [{ _id: { $oid: "507f1f77bcf86cd799439011" } }],
          affected_rows: 0,
          execution_time_ms: 1,
          session_id: "live-run-session",
          sourceLabel: "users",
          sourceStatement: "select * from users",
        },
        resultLocalSortOriginalRows: [[2]],
        resultLocalSortOriginalMongoDocuments: [{ _id: "2", role: "maintainer" }],
        resultLocalSortOriginalMongoCopyDocuments: [{ _id: { $oid: "507f1f77bcf86cd799439012" } }],
      },
    ],
  });

  const snapshot = buildTabResultSnapshot(tab);

  assert.equal(snapshot?.resultRuns?.[0]?.result?.session_id, undefined);
  assert.equal(snapshot?.resultRuns?.[0]?.result?.sourceLabel, "users");
  assert.equal(snapshot?.resultRuns?.[0]?.result?.sourceStatement, "select * from users");
  assert.deepEqual(snapshot?.resultRuns?.[0]?.result?.rows, [[1]]);
  assert.deepEqual(snapshot?.resultRuns?.[0]?.result?.mongo_copy_documents, [{ _id: { $oid: "507f1f77bcf86cd799439011" } }]);
  assert.deepEqual(snapshot?.resultRuns?.[0]?.resultLocalSortOriginalRows, [[2]]);
  assert.deepEqual(snapshot?.resultRuns?.[0]?.resultLocalSortOriginalMongoDocuments, [{ _id: "2", role: "maintainer" }]);
  assert.deepEqual(snapshot?.resultRuns?.[0]?.resultLocalSortOriginalMongoCopyDocuments, [{ _id: { $oid: "507f1f77bcf86cd799439012" } }]);
});

test("result snapshots preserve local column filters for all result windows", () => {
  const result = (filters?: Record<string, string[]>): QueryResult => ({
    columns: ["id", "status"],
    rows: [[1, "active"]],
    affected_rows: 0,
    execution_time_ms: 1,
    local_column_filters: filters,
  });
  const tab = queryTab({
    result: result({ "1": ["str:root"] }),
    results: [result({ "1": ["str:first"] }), result({ "1": ["str:second"] })],
    activeResultIndex: 0,
    resultRuns: [
      {
        id: "run-a",
        title: "Run A",
        sequence: 1,
        sql: "select 1",
        createdAt: 1,
        result: result({ "1": ["str:run-a"] }),
        results: [result({ "1": ["str:run-a-first"] }), result()],
        activeResultIndex: 0,
      },
      {
        id: "run-b",
        title: "Run B",
        sequence: 2,
        sql: "select 2",
        createdAt: 2,
        result: result({ "1": ["str:run-b"] }),
        results: [result({ "1": ["str:run-b-first"] })],
        activeResultIndex: 0,
      },
    ],
    activeResultRunId: "run-a",
  });

  const snapshot = buildTabResultSnapshot(tab);
  assert.deepEqual(snapshot?.result?.local_column_filters, { "1": ["str:root"] });
  assert.deepEqual(
    snapshot?.results?.map((item) => item.local_column_filters),
    [{ "1": ["str:first"] }, { "1": ["str:second"] }],
  );
  assert.deepEqual(
    snapshot?.resultRuns?.map((run) => run.result?.local_column_filters),
    [{ "1": ["str:run-a"] }, { "1": ["str:run-b"] }],
  );
  assert.deepEqual(
    snapshot?.resultRuns?.[0]?.results?.map((item) => item.local_column_filters),
    [{ "1": ["str:run-a-first"] }, undefined],
  );

  const restored = decodeTabResultSnapshot(encodeTabResultSnapshot(snapshot!));
  assert.deepEqual(restored?.result?.local_column_filters, { "1": ["str:root"] });
  assert.deepEqual(
    restored?.results?.map((item) => item.local_column_filters),
    [{ "1": ["str:first"] }, { "1": ["str:second"] }],
  );
  assert.deepEqual(
    restored?.resultRuns?.map((run) => run.result?.local_column_filters),
    [{ "1": ["str:run-a"] }, { "1": ["str:run-b"] }],
  );
  assert.deepEqual(
    restored?.resultRuns?.[0]?.results?.map((item) => item.local_column_filters),
    [{ "1": ["str:run-a-first"] }, undefined],
  );
});

test("result snapshots encode as binary columnar payloads and decode back to rows", () => {
  const snapshot = buildTabResultSnapshot(
    queryTab({
      result: {
        columns: ["id", "name", "active"],
        rows: [
          [1, "Ada", true],
          [2, "Linus", false],
        ],
        mongo_documents: [
          { _id: "1", name: "Ada", tags: ["admin"] },
          { _id: "2", name: "Linus", tags: ["maintainer"] },
        ],
        mongo_copy_documents: [
          { _id: { $oid: "507f1f77bcf86cd799439011" }, createdAt: { $date: "2026-07-24T00:00:00Z" } },
          { _id: { $oid: "507f1f77bcf86cd799439012" }, counter: { $numberLong: "9007199254740993" } },
        ],
        affected_rows: 0,
        execution_time_ms: 3,
        session_id: "live-session",
        has_more: true,
        sourceLabel: "public.users",
        sourceStatement: "select id, name, active from public.users",
      },
      resultLocalSortOriginalRows: [
        [2, "Linus", false],
        [1, "Ada", true],
      ],
      resultLocalSortOriginalMongoDocuments: [
        { _id: "2", name: "Linus", tags: ["maintainer"] },
        { _id: "1", name: "Ada", tags: ["admin"] },
      ],
      resultLocalSortOriginalMongoCopyDocuments: [
        { _id: { $oid: "507f1f77bcf86cd799439012" }, counter: { $numberLong: "9007199254740993" } },
        { _id: { $oid: "507f1f77bcf86cd799439011" }, createdAt: { $date: "2026-07-24T00:00:00Z" } },
      ],
    }),
  );
  assert.ok(snapshot);

  const encoded = encodeTabResultSnapshot(snapshot);
  const decoded = decodeTabResultSnapshot(encoded);

  assert.ok(encoded instanceof Uint8Array);
  assert.deepEqual(decoded?.result?.columns, ["id", "name", "active"]);
  assert.deepEqual(decoded?.result?.rows, [
    [1, "Ada", true],
    [2, "Linus", false],
  ]);
  assert.deepEqual(decoded?.result?.mongo_documents, [
    { _id: "1", name: "Ada", tags: ["admin"] },
    { _id: "2", name: "Linus", tags: ["maintainer"] },
  ]);
  assert.deepEqual(decoded?.result?.mongo_copy_documents, [
    { _id: { $oid: "507f1f77bcf86cd799439011" }, createdAt: { $date: "2026-07-24T00:00:00Z" } },
    { _id: { $oid: "507f1f77bcf86cd799439012" }, counter: { $numberLong: "9007199254740993" } },
  ]);
  assert.deepEqual(decoded?.resultLocalSortOriginalRows, [
    [2, "Linus", false],
    [1, "Ada", true],
  ]);
  assert.deepEqual(decoded?.resultLocalSortOriginalMongoDocuments, [
    { _id: "2", name: "Linus", tags: ["maintainer"] },
    { _id: "1", name: "Ada", tags: ["admin"] },
  ]);
  assert.deepEqual(decoded?.resultLocalSortOriginalMongoCopyDocuments, [
    { _id: { $oid: "507f1f77bcf86cd799439012" }, counter: { $numberLong: "9007199254740993" } },
    { _id: { $oid: "507f1f77bcf86cd799439011" }, createdAt: { $date: "2026-07-24T00:00:00Z" } },
  ]);
  assert.equal(decoded?.result?.session_id, undefined);
  assert.equal(decoded?.result?.has_more, true);
  assert.equal(decoded?.result?.sourceLabel, "public.users");
  assert.equal(decoded?.result?.sourceStatement, "select id, name, active from public.users");
  assert.equal(decoded?.cachedAt, snapshot.cachedAt);
});
