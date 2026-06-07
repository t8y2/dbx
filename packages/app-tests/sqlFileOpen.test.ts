import { strict as assert } from "node:assert";
import test from "node:test";
import { externalSqlFilePaths, isSqlFilePath, sqlFileTitleFromPath } from "../../apps/desktop/src/lib/sqlFileOpen.ts";

test("detects SQL file paths case-insensitively", () => {
  assert.equal(isSqlFilePath("/tmp/report.sql"), true);
  assert.equal(isSqlFilePath("C:\\Users\\me\\Query.SQL"), true);
  assert.equal(isSqlFilePath("/tmp/report.txt"), false);
});

test("derives a tab title from Unix or Windows SQL paths", () => {
  assert.equal(sqlFileTitleFromPath("/tmp/report.sql"), "report.sql");
  assert.equal(sqlFileTitleFromPath("C:\\Users\\me\\Query.SQL"), "Query.SQL");
});

test("filters external open payloads down to SQL files", () => {
  assert.deepEqual(externalSqlFilePaths(["/tmp/a.sql", "/tmp/readme.md", "/tmp/b.SQL"]), ["/tmp/a.sql", "/tmp/b.SQL"]);
});
