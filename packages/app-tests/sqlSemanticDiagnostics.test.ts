import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildSqlParserErrorDiagnostic, buildSqlSemanticDiagnostics, areSqlSemanticDiagnosticsEqual, isSqlSemanticDiagnosticInputContext, shouldRunSqlSemanticDiagnostics } from "../../apps/desktop/src/lib/sqlSemanticDiagnostics.ts";
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
  assert.equal(diagnostics[0]?.severity, "error");
});

test("flags confirmed missing tables", () => {
  const analysis: SqlReferenceAnalysis = {
    tables: [{ name: "t_19991", span: span(15, 23) }],
    columns: [],
  };

  const diagnostics = buildSqlSemanticDiagnostics(analysis, {
    tables: [],
    columnsByTable: new Map(),
    missingTables: new Set(["t_19991"]),
  });

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    ["Unknown table t_19991"],
  );
  assert.equal(diagnostics[0]?.severity, "error");
});

test("flags missing columns when column metadata is cached with a schema key", () => {
  const analysis: SqlReferenceAnalysis = {
    tables: [{ name: "t_10001", span: span(24, 32) }],
    columns: [{ name: "bad_field", span: span(8, 17) }],
  };

  const diagnostics = buildSqlSemanticDiagnostics(analysis, {
    tables: [{ name: "t_10001", type: "table" }],
    columnsByTable: new Map([["demo_2000_tables.t_10001", [{ name: "id", table: "t_10001" }]]]),
  });

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    ["Unknown column bad_field"],
  );
  assert.equal(diagnostics[0]?.severity, "error");
});

test("flags missing columns when loaded column metadata is empty", () => {
  const analysis: SqlReferenceAnalysis = {
    tables: [{ name: "t_0001", span: span(15, 22) }],
    columns: [{ name: "ids", span: span(30, 33) }],
  };

  const diagnostics = buildSqlSemanticDiagnostics(analysis, {
    tables: [{ name: "t_0001", type: "table" }],
    columnsByTable: new Map([["t_0001", []]]),
    loadedColumnTables: new Set(["t_0001"]),
  });

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    ["Unknown column ids"],
  );
});

test("flags where-clause columns missing from a single referenced table", () => {
  const analysis: SqlReferenceAnalysis = {
    tables: [{ name: "t_0001", span: span(15, 22) }],
    columns: [{ name: "ids", span: span(30, 33) }],
  };

  const diagnostics = buildSqlSemanticDiagnostics(analysis, {
    tables: [{ name: "t_0001", type: "table" }],
    columnsByTable: new Map([["t_0001", ["id", "image_name", "image_mime", "image_data", "image_url"].map((name) => ({ name, table: "t_0001" }))]]),
  });

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    ["Unknown column ids"],
  );
});

test("resolves unqualified columns against the table in the same statement", () => {
  const sql = "SELECT * FROM `t_00011` WHERE id > 1; SELECT * FROM `t_0001` where ids > 1 LIMIT 50;";
  const analysis: SqlReferenceAnalysis = {
    tables: [
      { name: "t_00011", span: { start_line: 1, start_column: 15, end_line: 1, end_column: 24 } },
      { name: "t_0001", span: { start_line: 1, start_column: 54, end_line: 1, end_column: 62 } },
    ],
    columns: [
      { name: "id", span: { start_line: 1, start_column: 31, end_line: 1, end_column: 33 } },
      { name: "ids", span: { start_line: 1, start_column: 69, end_line: 1, end_column: 72 } },
    ],
  };

  const diagnostics = buildSqlSemanticDiagnostics(analysis, {
    tables: [
      { name: "t_00011", type: "table" },
      { name: "t_0001", type: "table" },
    ],
    columnsByTable: new Map([
      ["t_00011", [{ name: "id", table: "t_00011" }]],
      ["t_0001", [{ name: "id", table: "t_0001" }]],
    ]),
    sql,
  });

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    ["Unknown column ids"],
  );
});

test("resolves qualified aliases against the table in the same statement", () => {
  const sql = "SELECT x.id FROM t_one x; SELECT x.bad FROM t_two x;";
  const analysis: SqlReferenceAnalysis = {
    tables: [
      { name: "t_one", alias: "x", span: { start_line: 1, start_column: 18, end_line: 1, end_column: 23 } },
      { name: "t_two", alias: "x", span: { start_line: 1, start_column: 45, end_line: 1, end_column: 50 } },
    ],
    columns: [
      { name: "id", qualifier: "x", span: { start_line: 1, start_column: 10, end_line: 1, end_column: 12 } },
      { name: "bad", qualifier: "x", span: { start_line: 1, start_column: 36, end_line: 1, end_column: 39 } },
    ],
  };

  const diagnostics = buildSqlSemanticDiagnostics(analysis, {
    tables: [
      { name: "t_one", type: "table" },
      { name: "t_two", type: "table" },
    ],
    columnsByTable: new Map([
      ["t_one", [{ name: "id", table: "t_one" }]],
      ["t_two", [{ name: "other", table: "t_two" }]],
    ]),
    sql,
  });

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    ["Unknown column x.bad"],
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
  assert.equal(shouldRunSqlSemanticDiagnostics("SELECT * FROM `t_19991` LIMIT 100", "SELECT * FROM `t_19991` LIMIT 100".length, { databaseType: "mysql" }), true);
  assert.equal(shouldRunSqlSemanticDiagnostics("SELECT * FROM `t_0001` where ids > 1 LIMIT 50;", "SELECT * FROM `t_0001` where ids > 1 LIMIT 50;".length, { databaseType: "mysql" }), true);
  assert.equal(isSqlSemanticDiagnosticInputContext("SELECT * FROM `t_0001` where ids > 1 LIMIT 50;", "SELECT * FROM `t_0001` where ids > 1 LIMIT 50;".length, { databaseType: "mysql" }), false);
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
