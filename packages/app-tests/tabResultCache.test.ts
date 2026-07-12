import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildTabResultSnapshot, decodeTabResultSnapshot, encodeTabResultSnapshot } from "../../apps/desktop/src/lib/tabs/tabResultCache.ts";
import type { QueryTab } from "../../apps/desktop/src/types/database.ts";

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
  });

  const snapshot = buildTabResultSnapshot(tab);

  assert.equal(snapshot?.result?.session_id, undefined);
  assert.equal(snapshot?.result?.sourceLabel, "public.users");
  assert.equal(snapshot?.result?.sourceStatement, "select * from public.users");
  assert.equal(snapshot?.results?.[0]?.session_id, undefined);
  assert.deepEqual(snapshot?.result?.rows, [[1]]);
  assert.deepEqual(snapshot?.result?.mongo_documents, [{ _id: "1", profile: { role: "admin" } }]);
  assert.deepEqual(snapshot?.resultLocalSortOriginalRows, [[2]]);
  assert.deepEqual(snapshot?.resultLocalSortOriginalMongoDocuments, [{ _id: "2", profile: { role: "maintainer" } }]);
  tab.result!.rows[0]![0] = 2;
  tab.resultLocalSortOriginalRows![0]![0] = 3;
  assert.deepEqual(snapshot?.result?.rows, [[1]]);
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
          affected_rows: 0,
          execution_time_ms: 1,
          session_id: "live-run-session",
          sourceLabel: "users",
          sourceStatement: "select * from users",
        },
        resultLocalSortOriginalRows: [[2]],
        resultLocalSortOriginalMongoDocuments: [{ _id: "2", role: "maintainer" }],
      },
    ],
  });

  const snapshot = buildTabResultSnapshot(tab);

  assert.equal(snapshot?.resultRuns?.[0]?.result?.session_id, undefined);
  assert.equal(snapshot?.resultRuns?.[0]?.result?.sourceLabel, "users");
  assert.equal(snapshot?.resultRuns?.[0]?.result?.sourceStatement, "select * from users");
  assert.deepEqual(snapshot?.resultRuns?.[0]?.result?.rows, [[1]]);
  assert.deepEqual(snapshot?.resultRuns?.[0]?.resultLocalSortOriginalRows, [[2]]);
  assert.deepEqual(snapshot?.resultRuns?.[0]?.resultLocalSortOriginalMongoDocuments, [{ _id: "2", role: "maintainer" }]);
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
  assert.deepEqual(decoded?.resultLocalSortOriginalRows, [
    [2, "Linus", false],
    [1, "Ada", true],
  ]);
  assert.deepEqual(decoded?.resultLocalSortOriginalMongoDocuments, [
    { _id: "2", name: "Linus", tags: ["maintainer"] },
    { _id: "1", name: "Ada", tags: ["admin"] },
  ]);
  assert.equal(decoded?.result?.session_id, undefined);
  assert.equal(decoded?.result?.has_more, true);
  assert.equal(decoded?.result?.sourceLabel, "public.users");
  assert.equal(decoded?.result?.sourceStatement, "select id, name, active from public.users");
  assert.equal(decoded?.cachedAt, snapshot.cachedAt);
});
