import { strict as assert } from "node:assert";
import { test } from "vitest";
import { BackendErrorException } from "../../apps/desktop/src/lib/backend/errorUtils.ts";
import { createTableGenerateState, formatGeneratedRowValues, generateInsertBatches, generateTableData, supportsGeneratedMultiRowValues, type TableGenerateConfig } from "../../apps/desktop/src/lib/dataGrid/dataGenerate.ts";
import { errorMessage, isQueryCanceledError, summarizeBatchResults } from "../../apps/desktop/src/lib/dataGrid/generateInsertAccounting.ts";
import type { QueryResult } from "../../apps/desktop/src/types/database.ts";

function makeConfig(rowCount: number): TableGenerateConfig {
  return {
    tableName: "users",
    schema: "public",
    database: "app",
    rowCount,
    columns: [{ columnName: "id", dataType: "bigint", rowCount, generatorKey: "sequence", generatorParams: { startValue: 1, increment: 1 } }],
  };
}

function state(databaseType: string, rowCount: number) {
  return createTableGenerateState(makeConfig(rowCount), databaseType as never);
}

function result(options: { executionError?: boolean; error?: { detail?: string; messageKey?: string }; rows?: unknown[][]; affected?: number } = {}): QueryResult {
  return {
    columns: ["affected"],
    rows: options.rows ?? [],
    affected_rows: options.affected ?? 0,
    execution_time_ms: 1,
    ...(options.executionError ? { execution_error: true as const } : {}),
    ...(options.error ? { error: { version: 1, code: "DBX-TEST-0001", messageKey: options.error.messageKey ?? "backendErrors.test", messageParams: {}, source: "test", operationOutcome: "unknown", ...(options.error.detail ? { detail: options.error.detail } : {}) } } : {}),
  } as QueryResult;
}

function valueRows(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `(${index + 1})`);
}

test("generateInsertBatches maps one multi-row statement to all of its rows", () => {
  const batches = generateInsertBatches("mysql", state("mysql", 3), valueRows(3));
  assert.equal(batches.statements.length, 1);
  assert.deepEqual(batches.rowsPerStatement, [3]);
});

test("generateInsertBatches maps single-row statements one row each", () => {
  const batches = generateInsertBatches("mysql", state("mysql", 3), valueRows(3), true);
  assert.equal(batches.statements.length, 3);
  assert.deepEqual(batches.rowsPerStatement, [1, 1, 1]);
});

test("generateInsertBatches keeps counts aligned for databases without multi-row support", () => {
  const batches = generateInsertBatches("iris", state("iris", 2), valueRows(2));
  assert.equal(batches.statements.length, 2);
  assert.deepEqual(batches.rowsPerStatement, [1, 1]);
});

test("generateInsertBatches mirrors Oracle INSERT ALL chunking", () => {
  const batches = generateInsertBatches("oracle", state("oracle", 101), valueRows(101));
  assert.equal(batches.statements.length, 2);
  assert.deepEqual(batches.rowsPerStatement, [100, 1]);

  const single = generateInsertBatches("oracle", state("oracle", 1), valueRows(1));
  assert.equal(single.statements.length, 1);
  assert.deepEqual(single.rowsPerStatement, [1]);
});

test("OceanBase Oracle generation batches 0/1/2/100/101 rows with matching statement accounting", () => {
  for (const [count, expectedCounts] of [
    [0, []],
    [1, [1]],
    [2, [2]],
    [100, [100]],
    [101, [100, 1]],
  ] as const) {
    const config = makeConfig(count);
    const generated = generateTableData(config, "oceanbase-oracle");
    const generationState = createTableGenerateState(config, "oceanbase-oracle");
    const formattedRows = generated.rows.map((row) => formatGeneratedRowValues(config, "oceanbase-oracle", generationState, row));
    const batches = generateInsertBatches("oceanbase-oracle", generationState, formattedRows);
    assert.equal(generated.rows.length, count);
    assert.deepEqual(generated.statements, batches.statements);
    assert.deepEqual(batches.rowsPerStatement, expectedCounts);
    assert.equal(generated.statements.length, expectedCounts.length);
    for (const [index, sql] of generated.statements.entries()) {
      if (count === 1) assert.match(sql, /^INSERT INTO /);
      else {
        assert.match(sql, /^INSERT ALL\n/);
        assert.match(sql, /SELECT 1 FROM DUAL;$/);
        assert.equal(sql.match(/\n  INTO /g)?.length, expectedCounts[index]);
      }
      assert.doesNotMatch(sql, /VALUES\s*\([^;]+\),\s*\(/s);
    }
  }
  assert.equal(supportsGeneratedMultiRowValues("oceanbase-oracle"), false);
});

test("OceanBase Oracle generation preserves quoted names and typed temporal and null values", () => {
  const generated = generateTableData(
    {
      tableName: "Items",
      schema: "APP",
      database: "oracletest",
      rowCount: 2,
      columns: [
        { columnName: "ID", dataType: "NUMBER", rowCount: 2, generatorKey: "sequence", generatorParams: { startValue: 1, increment: 1 } },
        { columnName: "Name", dataType: "VARCHAR2(30)", rowCount: 2, generatorKey: "enum", generatorParams: { values: "O'Brien" } },
        { columnName: "CREATED", dataType: "DATE", rowCount: 2, generatorKey: "enum", generatorParams: { values: "2026-10-09" } },
        { columnName: "STAMP", dataType: "TIMESTAMP(6)", rowCount: 2, generatorKey: "enum", generatorParams: { values: "2026-10-09 12:34:56" } },
        { columnName: "EMPTY", dataType: "VARCHAR2(30)", rowCount: 2, generatorKey: "enum", generatorParams: { values: "unused", includeNull: true, nullPercent: 100 } },
      ],
    },
    "oceanbase-oracle",
  );
  assert.equal(generated.statements.length, 1);
  assert.match(generated.sql, /INTO "APP"\."Items" \("ID", "Name", "CREATED", "STAMP", "EMPTY"\)/);
  assert.match(generated.sql, /'O''Brien'/);
  assert.match(generated.sql, /TO_DATE\('2026-10-09', 'YYYY-MM-DD'\)/);
  assert.match(generated.sql, /TO_TIMESTAMP\('2026-10-09 12:34:56', 'YYYY-MM-DD HH24:MI:SS'\)/);
  assert.match(generated.sql, /, NULL\)/);
});

test("generateInsertBatches returns nothing for an empty batch", () => {
  const batches = generateInsertBatches("mysql", state("mysql", 0), []);
  assert.deepEqual(batches.statements, []);
  assert.deepEqual(batches.rowsPerStatement, []);
});

test("summarizeBatchResults counts every row when all statements succeed", () => {
  const outcome = summarizeBatchResults([result({ affected: 3 })], [3]);
  assert.equal(outcome.insertedRows, 3);
  assert.equal(outcome.failed, false);
  assert.equal(outcome.error, undefined);
});

test("summarizeBatchResults ignores failed statements that do not throw", () => {
  // Sequential executor and the MySQL batch route resolve with the failure
  // recorded in the result array instead of rejecting.
  const outcome = summarizeBatchResults([result({ affected: 2 }), result({ executionError: true, error: { detail: "Duplicate entry" } }), result({ affected: 1 })], [2, 5, 1]);
  assert.equal(outcome.insertedRows, 3);
  assert.equal(outcome.failed, true);
  assert.equal(outcome.error, "Duplicate entry");
  assert.equal(outcome.failedStatement, 1);
});

test("summarizeBatchResults reads driver messages from error-shaped rows", () => {
  const outcome = summarizeBatchResults([result({ executionError: true, rows: [["relation missing_table does not exist"]] })], [4]);
  assert.equal(outcome.insertedRows, 0);
  assert.equal(outcome.failed, true);
  assert.equal(outcome.error, "relation missing_table does not exist");
});

test("summarizeBatchResults flags results that carry a structured error", () => {
  const outcome = summarizeBatchResults([result({ error: { messageKey: "backendErrors.poolCheckoutFailed" } })], [7]);
  assert.equal(outcome.failed, true);
  assert.equal(outcome.insertedRows, 0);
  assert.equal(outcome.error, "backendErrors.poolCheckoutFailed");
});

test("summarizeBatchResults ignores results beyond the statements that were sent", () => {
  const outcome = summarizeBatchResults([result({ affected: 1 }), result({ affected: 1 }), result({ executionError: true })], [1, 1]);
  assert.equal(outcome.insertedRows, 2);
  assert.equal(outcome.failed, false);
});

test("summarizeBatchResults treats a missing result array as zero confirmed rows", () => {
  const outcome = summarizeBatchResults(null, [3]);
  assert.equal(outcome.insertedRows, 0);
  assert.equal(outcome.failed, false);
});

test("summarizeBatchResults handles an empty batch", () => {
  const outcome = summarizeBatchResults([], []);
  assert.equal(outcome.insertedRows, 0);
  assert.equal(outcome.failed, false);
});

test("isQueryCanceledError recognizes the backend cancellation message", () => {
  assert.equal(isQueryCanceledError(new Error("Query canceled")), true);
  assert.equal(isQueryCanceledError("Query canceled"), true);
  assert.equal(isQueryCanceledError(new BackendErrorException({ message: "Query canceled" })), true);
});

test("isQueryCanceledError does not treat SQL failures as cancellations", () => {
  assert.equal(isQueryCanceledError(new Error('relation "users" does not exist')), false);
  assert.equal(isQueryCanceledError(new Error("Deadlock found when trying to get lock")), false);
  assert.equal(isQueryCanceledError(new BackendErrorException({ message: "Syntax error" })), false);
});

test("errorMessage unwraps Error instances and plain values", () => {
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage("plain failure"), "plain failure");
});
