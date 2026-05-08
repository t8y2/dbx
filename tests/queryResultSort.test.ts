import assert from "node:assert/strict";
import test from "node:test";
import { buildSortedQuerySql } from "../src/lib/queryResultSort.ts";

test("wraps a single select query with outer order by", () => {
  const result = buildSortedQuerySql("SELECT id, name FROM users;", "postgres", "name", "asc");
  assert.deepEqual(result, {
    ok: true,
    sql: 'SELECT * FROM (SELECT id, name FROM users) t ORDER BY "name" ASC;',
  });
});

test("preserves complex select body when wrapping sort sql", () => {
  const result = buildSortedQuerySql("SELECT id FROM users WHERE status = 'A'", "mysql", "id", "desc");
  assert.deepEqual(result, {
    ok: true,
    sql: "SELECT * FROM (SELECT id FROM users WHERE status = 'A') t ORDER BY `id` DESC;",
  });
});

test("rejects multiple statements for result sorting", () => {
  const result = buildSortedQuerySql("SELECT 1; SELECT 2;", "postgres", "id", "asc");
  assert.deepEqual(result, { ok: false, reason: "multi" });
});

test("rejects cte queries for result sorting", () => {
  const result = buildSortedQuerySql("WITH cte AS (SELECT 1) SELECT * FROM cte", "postgres", "id", "asc");
  assert.deepEqual(result, { ok: false, reason: "with" });
});

test("rejects non select statements for result sorting", () => {
  const result = buildSortedQuerySql("UPDATE users SET name = 'A'", "postgres", "name", "asc");
  assert.deepEqual(result, { ok: false, reason: "not_select" });
});
