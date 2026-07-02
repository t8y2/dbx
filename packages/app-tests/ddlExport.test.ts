import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildSingleDdlExportFileContent, ensureSqlStatementTerminator, joinExportedDdls } from "../../apps/desktop/src/lib/ddlExport.ts";

test("ensureSqlStatementTerminator appends a trailing semicolon when missing", () => {
  assert.equal(ensureSqlStatementTerminator("CREATE TABLE `users` (\n  `id` int\n) ENGINE=InnoDB"), "CREATE TABLE `users` (\n  `id` int\n) ENGINE=InnoDB;");
});

test("ensureSqlStatementTerminator does not duplicate an existing trailing semicolon", () => {
  assert.equal(ensureSqlStatementTerminator("CREATE VIEW v AS SELECT 1;"), "CREATE VIEW v AS SELECT 1;");
});

test("joinExportedDdls separates exported objects with blank lines and terminates each statement", () => {
  assert.equal(
    joinExportedDdls([
      "CREATE TABLE `users` (`id` int)",
      "CREATE TABLE `posts` (`id` int);",
    ]),
    "CREATE TABLE `users` (`id` int);\n\nCREATE TABLE `posts` (`id` int);\n",
  );
});

test("buildSingleDdlExportFileContent emits a single importable statement with one trailing newline", () => {
  assert.equal(
    buildSingleDdlExportFileContent("  CREATE TABLE `users` (`id` int)  "),
    "CREATE TABLE `users` (`id` int);\n",
  );
});
