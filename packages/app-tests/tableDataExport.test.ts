import { strict as assert } from "node:assert";
import { test } from "vitest";
import { fetchTableDataForExport, TABLE_DATA_EXPORT_PAGE_SIZE } from "../../apps/desktop/src/lib/table/tableDataExport.ts";
import type { QueryResult } from "../../apps/desktop/src/types/database.ts";

function result(rows: QueryResult["rows"]): QueryResult {
  return {
    columns: ["id"],
    rows,
    affected_rows: 0,
    execution_time_ms: 1,
    truncated: false,
    has_more: false,
  };
}

test("fetchTableDataForExport pages past the 10000 row export boundary", async () => {
  const sqls: string[] = [];
  const pages = [result(Array.from({ length: TABLE_DATA_EXPORT_PAGE_SIZE }, (_, index) => [index + 1])), result([[10_001], [10_002]])];

  const exported = await fetchTableDataForExport({
    databaseType: "mysql",
    tableName: "users",
    buildPageSql: ({ limit, offset }) => (offset ? `SELECT * FROM \`users\` LIMIT ${limit} OFFSET ${offset};` : `SELECT * FROM \`users\` LIMIT ${limit};`),
    executePage: async (sql) => {
      sqls.push(sql);
      return pages.shift() ?? result([]);
    },
  });

  assert.equal(exported.rows.length, TABLE_DATA_EXPORT_PAGE_SIZE + 2);
  assert.deepEqual(exported.rows.at(-1), [10_002]);
  assert.deepEqual(sqls, ["SELECT * FROM `users` LIMIT 10000;", "SELECT * FROM `users` LIMIT 10000 OFFSET 10000;"]);
  assert.equal(exported.truncated, false);
});

test("fetchTableDataForExport executes a VictoriaMetrics range query once", async () => {
  const sqls: string[] = [];
  const exported = await fetchTableDataForExport({
    databaseType: "victoriametrics",
    tableName: "flag",
    executePage: async (sql) => {
      sqls.push(sql);
      return result([[1], [2]]);
    },
  });

  assert.deepEqual(sqls, ['{__name__="flag"}[1h]']);
  assert.equal(exported.rows.length, 2);
});

test("fetchTableDataForExport advances a Cassandra cursor past 10000 rows exactly once", async () => {
  const firstRows = Array.from({ length: TABLE_DATA_EXPORT_PAGE_SIZE }, (_, index) => [index + 1]);
  const requests: Array<{ sql: string; resultSessionId?: string }> = [];
  const closed: Array<string | undefined> = [];
  const pages = [{ ...result(firstRows), session_id: "cursor-1", has_more: true }, result([[10_001], [10_002]])];

  const exported = await fetchTableDataForExport({
    databaseType: "cassandra",
    tableName: "events",
    useAgentCursor: true,
    buildPageSql: () => 'SELECT * FROM "events";',
    executePage: async (sql, options) => {
      requests.push({ sql, resultSessionId: options?.resultSessionId });
      return pages.shift() ?? result([]);
    },
    closeCursor: async (sessionId) => {
      closed.push(sessionId);
    },
  });

  assert.equal(exported.rows.length, TABLE_DATA_EXPORT_PAGE_SIZE + 2);
  assert.equal(new Set(exported.rows.map((row) => row[0])).size, TABLE_DATA_EXPORT_PAGE_SIZE + 2);
  assert.deepEqual(requests, [
    { sql: 'SELECT * FROM "events";', resultSessionId: undefined },
    { sql: 'SELECT * FROM "events";', resultSessionId: "cursor-1" },
  ]);
  assert.deepEqual(closed, [undefined]);
});

test("fetchTableDataForExport trusts has_more for short and exact cursor pages", async () => {
  const pages = [{ ...result([[1]]), session_id: "cursor-1", has_more: true }, { ...result([[2], [3]]), session_id: "cursor-1", has_more: true }, result([[4], [5]])];

  const exported = await fetchTableDataForExport({
    databaseType: "cassandra",
    tableName: "events",
    pageSize: 2,
    useAgentCursor: true,
    buildPageSql: () => 'SELECT * FROM "events";',
    executePage: async () => pages.shift() ?? result([]),
  });

  assert.deepEqual(exported.rows, [[1], [2], [3], [4], [5]]);
});

test("fetchTableDataForExport returns an empty terminal cursor page", async () => {
  const exported = await fetchTableDataForExport({
    databaseType: "cassandra",
    tableName: "events",
    useAgentCursor: true,
    buildPageSql: () => 'SELECT * FROM "events";',
    executePage: async () => result([]),
  });

  assert.deepEqual(exported.rows, []);
});

test("fetchTableDataForExport rejects missing and malformed cursor sessions", async () => {
  for (const sessionId of [undefined, "   "]) {
    let calls = 0;
    await assert.rejects(
      fetchTableDataForExport({
        databaseType: "cassandra",
        tableName: "events",
        useAgentCursor: true,
        buildPageSql: () => 'SELECT * FROM "events";',
        executePage: async () => {
          calls += 1;
          return { ...result([[1]]), session_id: sessionId, has_more: true };
        },
      }),
      /session/i,
    );
    assert.equal(calls, 1);
  }
});

test("fetchTableDataForExport closes an active cursor after an error", async () => {
  const closed: Array<string | undefined> = [];
  let calls = 0;
  await assert.rejects(
    fetchTableDataForExport({
      databaseType: "cassandra",
      tableName: "events",
      useAgentCursor: true,
      buildPageSql: () => 'SELECT * FROM "events";',
      executePage: async () => {
        calls += 1;
        if (calls === 1) return { ...result([[1]]), session_id: "cursor-1", has_more: true };
        throw new Error("cursor lost");
      },
      closeCursor: async (sessionId) => {
        closed.push(sessionId);
      },
    }),
    /cursor lost/,
  );

  assert.deepEqual(closed, ["cursor-1"]);
});

test("fetchTableDataForExport refuses incomplete cursor pages and retains the active session for cleanup", async () => {
  for (const malformed of [{ has_more: undefined }, { has_more: "false" }, { has_more: false, truncated: true }, { has_more: true, session_id: " " }]) {
    const closed: Array<string | undefined> = [];
    let calls = 0;
    await assert.rejects(
      fetchTableDataForExport({
        databaseType: "cassandra",
        tableName: "events",
        useAgentCursor: true,
        buildPageSql: () => 'SELECT * FROM "events";',
        executePage: async () => {
          calls += 1;
          if (calls === 1) return { ...result([[1]]), session_id: "cursor-1", has_more: true };
          return { ...result([[2]]), ...malformed } as QueryResult;
        },
        closeCursor: async (sessionId) => {
          closed.push(sessionId);
        },
      }),
      /export/i,
    );
    assert.equal(calls, 2);
    assert.deepEqual(closed, ["cursor-1"]);
  }
});

test("fetchTableDataForExport preserves non-cursor results without cursor metadata", async () => {
  const exported = await fetchTableDataForExport({
    databaseType: "mysql",
    tableName: "events",
    buildPageSql: () => "SELECT id FROM events LIMIT 10000;",
    executePage: async () => ({ ...result([[1]]), has_more: undefined }),
  });
  assert.deepEqual(exported.rows, [[1]]);
});
