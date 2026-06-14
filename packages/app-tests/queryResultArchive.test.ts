import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildTabResultSnapshot } from "../../apps/desktop/src/lib/tabResultCache.ts";
import { decodeQueryResultArchive, defaultQueryResultArchiveFileName, encodeQueryResultArchive } from "../../apps/desktop/src/lib/queryResultArchive.ts";
import type { QueryTab } from "../../apps/desktop/src/types/database.ts";

function queryTab(overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id: "tab-1",
    title: "Revenue / daily check",
    connectionId: "conn-1",
    database: "warehouse",
    schema: "public",
    sql: "select * from revenue",
    lastExecutedSql: "select * from revenue",
    isExecuting: false,
    mode: "query",
    ...overrides,
  };
}

test("query result archives round-trip query tab metadata and result runs", async () => {
  const tab = queryTab({
    resultRuns: [
      {
        id: "run-1",
        title: "Run 1",
        sequence: 1,
        sql: "select 1",
        createdAt: 10,
        result: {
          columns: ["id", "name"],
          rows: [
            [1, "Ada"],
            [2, "Linus"],
          ],
          affected_rows: 0,
          execution_time_ms: 3,
          session_id: "live-session",
        },
      },
      {
        id: "run-2",
        title: "Run 2",
        sequence: 2,
        sql: "select 2",
        createdAt: 20,
        result: {
          columns: ["id", "status"],
          rows: [[2, "paid"]],
          affected_rows: 0,
          execution_time_ms: 5,
        },
      },
    ],
    activeResultRunId: "run-2",
    result: {
      columns: ["id", "status"],
      rows: [[2, "paid"]],
      affected_rows: 0,
      execution_time_ms: 5,
    },
  });
  const snapshot = buildTabResultSnapshot(tab);
  assert.ok(snapshot);

  const bytes = await encodeQueryResultArchive(tab, snapshot);
  const decoded = await decodeQueryResultArchive(bytes);

  assert.ok(bytes instanceof Uint8Array);
  assert.equal(decoded?.tab.title, "Revenue / daily check");
  assert.equal(decoded?.tab.connectionId, "conn-1");
  assert.equal(decoded?.tab.database, "warehouse");
  assert.equal(decoded?.tab.schema, "public");
  assert.equal(decoded?.tab.sql, "select * from revenue");
  assert.equal(decoded?.snapshot.activeResultRunId, "run-2");
  assert.deepEqual(decoded?.snapshot.resultRuns?.map((run) => run.sequence), [1, 2]);
  assert.deepEqual(decoded?.snapshot.resultRuns?.[0]?.result?.rows, [
    [1, "Ada"],
    [2, "Linus"],
  ]);
  assert.equal(decoded?.snapshot.resultRuns?.[0]?.result?.session_id, undefined);
});

test("query result archives reject invalid files", async () => {
  assert.equal(await decodeQueryResultArchive(new Uint8Array([1, 2, 3, 4])), undefined);
});

test("query result archive file names are safe and use dbxresults extension", () => {
  assert.equal(defaultQueryResultArchiveFileName("Revenue / daily check"), "Revenue_daily_check.dbxresults");
  assert.equal(defaultQueryResultArchiveFileName(""), "query-results.dbxresults");
});

test("query result archives are compact for repeated tabular values", async () => {
  const rows = Array.from({ length: 100 }, (_, index) => [index, "same-region", "same-status"]);
  const tab = queryTab({
    title: "Repeated values",
    result: {
      columns: ["id", "region", "status"],
      rows,
      affected_rows: 0,
      execution_time_ms: 7,
    },
  });
  const snapshot = buildTabResultSnapshot(tab);
  assert.ok(snapshot);

  const bytes = await encodeQueryResultArchive(tab, snapshot);
  const jsonSize = new TextEncoder().encode(JSON.stringify({ tab, snapshot })).length;

  assert.ok(bytes.length < jsonSize, `expected archive ${bytes.length} bytes to be smaller than JSON ${jsonSize} bytes`);
});
