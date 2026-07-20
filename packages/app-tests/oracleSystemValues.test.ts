import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildSqlCompletionItems } from "../../apps/desktop/src/lib/sql/sqlCompletion.ts";
import { buildSqlSemanticDiagnostics } from "../../apps/desktop/src/lib/sql/semantic/diagnostics.ts";
import type { SqlReferenceAnalysis } from "../../apps/desktop/src/types/database.ts";

const ORACLE_SYSTEM_VALUES = ["SYSDATE", "SYSTIMESTAMP", "CURRENT_DATE", "CURRENT_TIMESTAMP", "LOCALTIMESTAMP", "SESSIONTIMEZONE", "DBTIMEZONE", "USER", "UID"];

const span = (startColumn: number, endColumn: number) => ({
  start_line: 1,
  start_column: startColumn,
  end_line: 1,
  end_column: endColumn,
});

test("suggests Oracle system values without function-call parentheses", () => {
  for (const name of ORACLE_SYSTEM_VALUES) {
    const prefix = name.slice(0, Math.min(5, name.length));
    const sql = `SELECT * FROM orders WHERE created_at > ${prefix}`;
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "orders", type: "table" }],
      columnsByTable: new Map([["orders", [{ name: "created_at", table: "orders" }]]]),
      databaseType: "oracle",
    });

    const systemValue = items.find((item) => item.label === name);
    assert.equal(systemValue?.type, "function", name);
    assert.equal(systemValue?.apply, name, name);
    assert.equal(systemValue?.detail, "Oracle system value", name);
  }
});

test("does not flag unquoted Oracle system values as table columns", () => {
  for (const name of ORACLE_SYSTEM_VALUES) {
    const sql = `SELECT id FROM orders WHERE ${name} IS NOT NULL`;
    const startColumn = sql.indexOf(name) + 1;
    const diagnostics = buildSqlSemanticDiagnostics(
      {
        tables: [{ name: "orders", span: span(16, 21), scope_id: 0 }],
        columns: [
          { name: "id", span: span(8, 9), scope_id: 0 },
          { name, span: span(startColumn, startColumn + name.length - 1), scope_id: 0 },
        ],
        scopes: [{ id: 0, parent_id: null }],
      },
      {
        tables: [{ name: "orders", type: "table" }],
        columnsByTable: new Map([["orders", [{ name: "id", table: "orders" }]]]),
        databaseType: "oracle",
        sql,
      },
    );
    assert.deepEqual(diagnostics, [], name);
  }
});

test("continues validating qualified and quoted Oracle system-value names as columns", () => {
  const sql = 'SELECT o.id FROM orders o WHERE missing > 0 AND o.SYSDATE > 0 AND "SYSDATE" > 0';
  const analysis: SqlReferenceAnalysis = {
    tables: [{ name: "orders", alias: "o", span: span(18, 23), scope_id: 0 }],
    columns: [
      { name: "id", qualifier: "o", span: span(10, 11), scope_id: 0 },
      { name: "missing", span: span(33, 39), scope_id: 0 },
      { name: "SYSDATE", qualifier: "o", span: span(51, 57), scope_id: 0 },
      { name: "SYSDATE", span: span(67, 75), scope_id: 0 },
    ],
    scopes: [{ id: 0, parent_id: null }],
  };

  const diagnostics = buildSqlSemanticDiagnostics(analysis, {
    tables: [{ name: "orders", type: "table" }],
    columnsByTable: new Map([["orders", [{ name: "id", table: "orders" }]]]),
    databaseType: "oracle",
    sql,
  });

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    ["Unknown column missing", "Unknown column o.SYSDATE", "Unknown column SYSDATE"],
  );
});
