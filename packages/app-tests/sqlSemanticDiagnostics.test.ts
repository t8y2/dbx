import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildSqlParserErrorDiagnostic, buildSqlSemanticDiagnostics, areSqlSemanticDiagnosticsEqual, shouldRunSqlSemanticDiagnostics } from "../../apps/desktop/src/lib/sqlSemanticDiagnostics.ts";
import type { SqlReferenceAnalysis } from "../../apps/desktop/src/types/database.ts";

const span = (startColumn: number, endColumn: number) => ({
  start_line: 1,
  start_column: startColumn,
  end_line: 1,
  end_column: endColumn,
});

test("flags missing qualified columns against the referenced table", () => {
  const analysis: SqlReferenceAnalysis = {
    tables: [{ name: "users", alias: "u", span: span(23, 27) }],
    columns: [
      { name: "missing", qualifier: "u", span: span(10, 16) },
      { name: "id", qualifier: "u", span: span(34, 35) },
    ],
  };

  const diagnostics = buildSqlSemanticDiagnostics(analysis, {
    tables: [{ name: "users", type: "table" }],
    columnsByTable: new Map([["users", [{ name: "id", table: "users" }]]]),
  });

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    ["Unknown column u.missing"],
  );
});

test("does not flag unqualified columns when multiple tables make ownership ambiguous", () => {
  const analysis: SqlReferenceAnalysis = {
    tables: [
      { name: "users", alias: "u", span: span(25, 29) },
      { name: "orders", alias: "o", span: span(35, 40) },
    ],
    columns: [{ name: "id", span: span(8, 9) }],
  };

  const diagnostics = buildSqlSemanticDiagnostics(analysis, {
    tables: [
      { name: "users", type: "table" },
      { name: "orders", type: "table" },
    ],
    columnsByTable: new Map(),
  });

  assert.deepEqual(diagnostics, []);
});

test("builds a syntax diagnostic from parser errors with line and column", () => {
  const diagnostic = buildSqlParserErrorDiagnostic("Expected: end of statement, found: FOM at Line: 1, Column: 10", "SELECT * FOM");

  assert.equal(diagnostic?.message, "Expected: end of statement, found: FOM at Line: 1, Column: 10");
  assert.deepEqual(diagnostic?.span, span(10, 12));
});

test("compares diagnostics by severity message and span", () => {
  const diagnostics = [
    {
      message: "Unknown column u.missing",
      severity: "warning" as const,
      span: span(10, 16),
    },
  ];

  assert.equal(
    areSqlSemanticDiagnosticsEqual(
      diagnostics,
      diagnostics.map((item) => ({ ...item })),
    ),
    true,
  );
  assert.equal(areSqlSemanticDiagnosticsEqual(diagnostics, [{ ...diagnostics[0], message: "Unknown column u.name" }]), false);
});

test("defers diagnostics while the cursor is in table completion context", () => {
  assert.equal(shouldRunSqlSemanticDiagnostics("select * from ", "select * from ".length), false);
  assert.equal(shouldRunSqlSemanticDiagnostics("select * from us", "select * from us".length), false);
  assert.equal(shouldRunSqlSemanticDiagnostics("select u.", "select u.".length), false);
  assert.equal(shouldRunSqlSemanticDiagnostics("select * from users where missing = 1", 42), true);
});

test("skips diagnostics for MongoDB connections", () => {
  assert.equal(shouldRunSqlSemanticDiagnostics("db.my_collection.find({})", 0, { databaseType: "mongodb" }), false);
});

test("skips diagnostics for Elasticsearch connections", () => {
  assert.equal(shouldRunSqlSemanticDiagnostics("db.my_collection.find({})", 0, { databaseType: "elasticsearch" }), false);
});

test("still runs diagnostics for SQL connections", () => {
  assert.equal(shouldRunSqlSemanticDiagnostics("SELECT * FROM users WHERE id = 1", 42, { databaseType: "mysql" }), true);
});
