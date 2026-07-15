import { strict as assert } from "node:assert";
import { test } from "vitest";
import { joinSqlStatementsForScript } from "../../apps/desktop/src/lib/sql/sqlBatchScript.ts";

const statements = [
  "ALTER TABLE [dbo].[GOODS] ADD [FYLKH] nvarchar(255);",
  "IF EXISTS (SELECT 1 FROM sys.extended_properties WHERE name = N'MS_Description') EXEC sys.sp_dropextendedproperty @name=N'MS_Description';",
  "EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'用料款号';",
];

test("separates SQL Server statements with GO batch separators", () => {
  const script = joinSqlStatementsForScript(statements, "sqlserver");
  assert.equal(script, statements.join("\nGO\n"));
});

test("does not append a trailing GO after the last SQL Server statement", () => {
  const script = joinSqlStatementsForScript(statements, "sqlserver");
  assert.ok(!script.endsWith("GO"));
  assert.equal(script.split("\nGO\n").length, statements.length);
});

test("keeps a single SQL Server statement without GO", () => {
  assert.equal(joinSqlStatementsForScript([statements[0]], "sqlserver"), statements[0]);
});

test("joins statements with newlines for other database types", () => {
  assert.equal(joinSqlStatementsForScript(statements, "mysql"), statements.join("\n"));
  assert.equal(joinSqlStatementsForScript(statements, undefined), statements.join("\n"));
});

test("returns an empty script for an empty statement list", () => {
  assert.equal(joinSqlStatementsForScript([], "sqlserver"), "");
  assert.equal(joinSqlStatementsForScript([], "mysql"), "");
});

test("keeps GO on its own line when statements carry trailing whitespace", () => {
  const script = joinSqlStatementsForScript(["SELECT 1;\n", "SELECT 2;  "], "sqlserver");
  assert.equal(script, "SELECT 1;\nGO\nSELECT 2;");
});
