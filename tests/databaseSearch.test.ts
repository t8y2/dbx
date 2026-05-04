import test from "node:test";
import assert from "node:assert/strict";
import type { ColumnInfo } from "../src/types/database.ts";
import {
  buildDatabaseSearchSql,
  buildSearchResultWhere,
  findMatchedSearchColumns,
} from "../src/lib/databaseSearch.ts";

function col(name: string, dataType: string, primary = false): ColumnInfo {
  return {
    name,
    data_type: dataType,
    is_nullable: true,
    column_default: null,
    is_primary_key: primary,
    extra: null,
  };
}

test("builds a table search query over text columns", () => {
  const query = buildDatabaseSearchSql({
    databaseType: "mysql",
    tableName: "users",
    columns: [col("id", "bigint", true), col("email", "varchar"), col("avatar", "blob")],
    term: "alice@example.com",
    limit: 20,
  });

  assert.ok(query);
  assert.deepEqual(query.searchableColumns, ["email"]);
  assert.equal(
    query.sql,
    "SELECT * FROM `users` WHERE (LOWER(CAST(`email` AS CHAR)) LIKE '%alice@example.com%' ESCAPE '~') LIMIT 20;",
  );
});

test("adds exact numeric predicates only when the search term is numeric", () => {
  const query = buildDatabaseSearchSql({
    databaseType: "postgres",
    schema: "public",
    tableName: "orders",
    columns: [col("id", "integer", true), col("note", "text")],
    term: "42",
    limit: 10,
  });

  assert.ok(query);
  assert.deepEqual(query.searchableColumns, ["note", "id"]);
  assert.match(query.sql, /"id" = 42/);
  assert.match(query.sql, /FROM "public"\."orders"/);
});

test("returns null when a table has no searchable columns", () => {
  const query = buildDatabaseSearchSql({
    databaseType: "sqlite",
    tableName: "files",
    columns: [col("payload", "blob")],
    term: "needle",
  });

  assert.equal(query, null);
});

test("finds matched columns from returned rows", () => {
  const matches = findMatchedSearchColumns(
    ["id", "email", "note"],
    [42, "Alice@Example.com", "inactive"],
    [col("id", "integer", true), col("email", "varchar"), col("note", "text")],
    "alice",
  );

  assert.deepEqual(matches, ["email"]);
});

test("builds a stable where predicate for opening a result row", () => {
  const where = buildSearchResultWhere({
    databaseType: "sqlserver",
    columns: [col("id", "integer", true), col("email", "varchar")],
    resultColumns: ["id", "email"],
    row: [42, "alice@example.com"],
  });

  assert.equal(where, "[id] = 42");
});
