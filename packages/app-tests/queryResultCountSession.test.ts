import assert from "node:assert/strict";
import { test } from "vitest";
import { sqlServerCountUsesLocalTempTable } from "../../apps/desktop/src/lib/query/queryResultCountSession.ts";

test("SQL Server result counts reuse the query session for local temporary tables", () => {
  for (const sql of ["SELECT COUNT(*) FROM #orders", "SELECT COUNT(*) FROM tempdb..#orders", "SELECT COUNT(*) FROM [#orders]", 'SELECT COUNT(*) FROM "#orders"']) {
    assert.equal(sqlServerCountUsesLocalTempTable("sqlserver", sql), true, sql);
  }
});

test("global temp tables, comments, literals, and other databases keep isolated count sessions", () => {
  assert.equal(sqlServerCountUsesLocalTempTable("sqlserver", "SELECT COUNT(*) FROM ##orders"), false);
  assert.equal(sqlServerCountUsesLocalTempTable("sqlserver", "SELECT '#orders' -- #ignored"), false);
  assert.equal(sqlServerCountUsesLocalTempTable("postgres", "SELECT COUNT(*) FROM #orders"), false);
});
