import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import * as langSql from "@codemirror/lang-sql";
import { createDbxCodeMirrorSqlDialect } from "../../apps/desktop/src/lib/editor/codemirrorSqlDialect.ts";
import { codeMirrorSqlDialect } from "../../apps/desktop/src/lib/database/jdbcDialect.ts";
import type { DatabaseType } from "../../apps/desktop/src/types/database.ts";

function hasKeyword(keywords: string | undefined, keyword: string): boolean {
  return new RegExp(`(?:^|\\s)${keyword}(?:\\s|$)`, "i").test(keywords || "");
}

function countParsedNodes(dialect: langSql.SQLDialect, sql: string, nodeName: string, text: string): number {
  const tree = dialect.language.parser.parse(sql);
  const cursor = tree.cursor();
  let count = 0;
  do {
    if (cursor.name === nodeName && sql.slice(cursor.from, cursor.to).toLowerCase() === text.toLowerCase()) count++;
  } while (cursor.next());
  return count;
}

test("adds SQL Server READONLY for table-valued procedure parameters", () => {
  const dialect = createDbxCodeMirrorSqlDialect(langSql, "sqlserver");

  assert.equal(hasKeyword(dialect.spec.keywords, "READONLY"), true);
  assert.equal(countParsedNodes(dialect, "CREATE PROCEDURE [dbo].[gylxcx](@tp2 XTableType5 readonly,@tp xtabletype2 readonly) AS SELECT 1", "Keyword", "readonly"), 2);
});

test("keeps DBX PostgreSQL procedural dialect extensions", () => {
  const dialect = createDbxCodeMirrorSqlDialect(langSql, "postgres");

  assert.equal(hasKeyword(dialect.spec.keywords, "PERFORM"), true);
  assert.equal(hasKeyword(dialect.spec.types, "JSONB"), true);
  assert.equal(hasKeyword(dialect.spec.builtin, "TG_NAME"), true);
});

test("treats compact double-dash comments as comments in non-MySQL SQL dialects", () => {
  const databaseTypes: DatabaseType[] = [
    "oracle",
    "dameng",
    "yashandb",
    "oscar",
    "oceanbase-oracle",
    "sqlite",
    "rqlite",
    "turso",
    "cloudflare-d1",
    "postgres",
    "redshift",
    "gaussdb",
    "kwdb",
    "kingbase",
    "highgo",
    "vastbase",
    "opengauss",
    "questdb",
    "sqlserver",
    "cassandra",
    "clickhouse",
    "duckdb",
    "databend",
    "db2",
    "hive",
    "spark",
  ];

  for (const databaseType of databaseTypes) {
    const dialect = createDbxCodeMirrorSqlDialect(langSql, codeMirrorSqlDialect(databaseType), databaseType);
    assert.equal(countParsedNodes(dialect, "--SELECT 1", "LineComment", "--SELECT 1"), 1, databaseType);
    assert.equal(countParsedNodes(dialect, "--SELECT 1", "Keyword", "SELECT"), 0, databaseType);
  }
});

test("keeps MySQL-compatible double-dash whitespace rules", () => {
  const databaseTypes: DatabaseType[] = ["mysql", "doris", "starrocks", "manticoresearch", "goldendb", "gbase"];

  for (const databaseType of databaseTypes) {
    const dialect = createDbxCodeMirrorSqlDialect(langSql, codeMirrorSqlDialect(databaseType), databaseType);
    assert.equal(countParsedNodes(dialect, "--SELECT 1", "LineComment", "--SELECT 1"), 0, databaseType);
    assert.equal(countParsedNodes(dialect, "--SELECT 1", "Keyword", "SELECT"), 1, databaseType);
    assert.equal(countParsedNodes(dialect, "-- SELECT 1", "LineComment", "-- SELECT 1"), 1, databaseType);
  }
});

test("propagates database type to every DDL viewer entrypoint", () => {
  const ddlViewDialog = readFileSync("apps/desktop/src/components/objects/DdlViewDialog.vue", "utf8");
  const treeItem = readFileSync("apps/desktop/src/components/sidebar/TreeItem.vue", "utf8");
  const app = readFileSync("apps/desktop/src/App.vue", "utf8");

  assert.match(ddlViewDialog, /createDbxCodeMirrorSqlDialect\(langSql, props\.dialect, props\.databaseType\)/);
  assert.match(treeItem, /<DdlViewDialog[\s\S]*?:database-type="ddlDatabaseType"[\s\S]*?v-model:open="showDdlDialog"/);
  assert.match(app, /<DdlViewDialog[^>]*:database-type="queryEditorDdlDatabaseType"[^>]*\/>/);
});
