import assert from "node:assert/strict";
import test from "node:test";
import { buildSortedQuerySql } from "../src/lib/queryResultSort.ts";

test("wraps a single select query with outer order by", () => {
  const result = buildSortedQuerySql("SELECT id, name FROM users;", "postgres", ["id", "name"], 1, "name", "asc");
  assert.deepEqual(result, {
    ok: true,
    sql: 'SELECT * FROM (SELECT id, name FROM users) t("id", "name") ORDER BY "name" ASC;',
  });
});

test("preserves complex select body when wrapping sort sql", () => {
  const result = buildSortedQuerySql("SELECT id FROM users WHERE status = 'A'", "mysql", ["id"], 0, "id", "desc");
  assert.deepEqual(result, {
    ok: true,
    sql: "SELECT * FROM (SELECT id FROM users WHERE status = 'A') t(`id`) ORDER BY `id` DESC;",
  });
});

test("assigns unique aliases for duplicate result column names", () => {
  const result = buildSortedQuerySql(
    "SELECT c.id, m.id FROM t_campaign c LEFT JOIN t_campaign_mdf m ON m.campaign_id = c.id",
    "mysql",
    ["id", "id"],
    1,
    "id",
    "asc",
  );
  assert.deepEqual(result, {
    ok: true,
    sql: "SELECT * FROM (SELECT c.id, m.id FROM t_campaign c LEFT JOIN t_campaign_mdf m ON m.campaign_id = c.id) t(`id`, `id_2`) ORDER BY `id_2` ASC;",
  });
});

test("rejects multiple statements for result sorting", () => {
  const result = buildSortedQuerySql("SELECT 1; SELECT 2;", "postgres", ["id"], 0, "id", "asc");
  assert.deepEqual(result, { ok: false, reason: "multi" });
});

test("rejects cte queries for result sorting", () => {
  const result = buildSortedQuerySql("WITH cte AS (SELECT 1) SELECT * FROM cte", "postgres", ["id"], 0, "id", "asc");
  assert.deepEqual(result, { ok: false, reason: "with" });
});

test("rejects non select statements for result sorting", () => {
  const result = buildSortedQuerySql("UPDATE users SET name = 'A'", "postgres", ["name"], 0, "name", "asc");
  assert.deepEqual(result, { ok: false, reason: "not_select" });
});
