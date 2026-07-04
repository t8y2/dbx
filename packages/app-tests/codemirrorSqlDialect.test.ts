import { strict as assert } from "node:assert";
import { test } from "vitest";
import * as langSql from "@codemirror/lang-sql";
import { createDbxCodeMirrorSqlDialect } from "../../apps/desktop/src/lib/editor/codemirrorSqlDialect.ts";

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
