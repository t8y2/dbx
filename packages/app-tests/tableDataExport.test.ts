import { strict as assert } from "node:assert";
import { test } from "vitest";
import { fetchTableDataForExport, TABLE_DATA_EXPORT_PAGE_SIZE } from "../../apps/desktop/src/lib/tableDataExport.ts";
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
