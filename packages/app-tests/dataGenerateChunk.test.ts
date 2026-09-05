import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  buildGenerateInsertStatements,
  createTableGenerateState,
  generateTableData,
  generateTableRowsChunk,
  splitValueRowsByByteBudget,
  type TableGenerateConfig,
} from "../../apps/desktop/src/lib/dataGrid/dataGenerate.ts";

function makeConfig(overrides: Partial<TableGenerateConfig> = {}): TableGenerateConfig {
  return {
    tableName: "users",
    schema: "public",
    database: "app",
    rowCount: 10,
    columns: [
      { columnName: "id", dataType: "bigint", rowCount: 10, generatorKey: "sequence", generatorParams: { startValue: 1, increment: 1 } },
      { columnName: "name", dataType: "varchar(32)", rowCount: 10, generatorKey: "text" },
    ],
    ...overrides,
  };
}

function deterministicConfig(rowCount: number): TableGenerateConfig {
  return {
    tableName: "users",
    schema: "public",
    database: "app",
    rowCount,
    columns: [
      { columnName: "id", dataType: "bigint", rowCount, generatorKey: "sequence", generatorParams: { startValue: 100, increment: 5 } },
      { columnName: "copy_of_id", dataType: "bigint", rowCount, generatorKey: "sequence", generatorParams: { startValue: 0, increment: -1 } },
    ],
  };
}

test("chunked generation produces exactly the same rows as one-shot generation", () => {
  const config = deterministicConfig(11);
  const expected = generateTableData(config, "mysql");

  const state = createTableGenerateState(config, "mysql");
  const chunked: unknown[][] = [];
  for (;;) {
    const rows = generateTableRowsChunk(config, state, 3);
    if (rows.length === 0) break;
    chunked.push(...rows);
  }

  assert.deepEqual(chunked, expected.rows);
});

test("unique values stay distinct across chunks", () => {
  const config = makeConfig({
    rowCount: 24,
    columns: [{ columnName: "code", dataType: "varchar(8)", rowCount: 24, generatorKey: "text", generatorParams: { unique: true } }],
  });

  const state = createTableGenerateState(config, "mysql");
  const all: unknown[] = [];
  for (;;) {
    const rows = generateTableRowsChunk(config, state, 5);
    if (rows.length === 0) break;
    all.push(...rows.map((row) => row[0]));
  }

  assert.equal(all.length, 24);
  assert.equal(new Set(all.map((value) => String(value))).size, 24);
});

test("sequence values continue monotonically across chunk boundaries", () => {
  const config = makeConfig({ rowCount: 7 });

  const state = createTableGenerateState(config, "mysql");
  const ids: number[] = [];
  for (;;) {
    const rows = generateTableRowsChunk(config, state, 2);
    if (rows.length === 0) break;
    ids.push(...rows.map((row) => row[0] as number));
  }

  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7]);
});

test("chunking respects exact boundaries and terminates cleanly", () => {
  const config = makeConfig({ rowCount: 6 });
  const state = createTableGenerateState(config, "mysql");

  assert.equal(generateTableRowsChunk(config, state, 0).length, 0);
  assert.equal(generateTableRowsChunk(config, state, -1).length, 0);
  assert.equal(generateTableRowsChunk(config, state, 6).length, 6);
  assert.equal(generateTableRowsChunk(config, state, 6).length, 0);
  assert.equal(generateTableRowsChunk(config, state, 100).length, 0);
});

test("a chunk larger than the remaining row count returns only the remainder", () => {
  const config = makeConfig({ rowCount: 4 });
  const state = createTableGenerateState(config, "mysql");

  assert.equal(generateTableRowsChunk(config, state, 3).length, 3);
  assert.equal(generateTableRowsChunk(config, state, 10).length, 1);
});

test("tdengine stable table keeps tag values and tbname coherent across chunks", () => {
  const config = makeConfig({
    tableName: "metrics",
    schema: "",
    database: "db",
    rowCount: 9,
    tableType: "STABLE",
    columns: [
      { columnName: "ts", dataType: "timestamp", rowCount: 9, generatorKey: "time" },
      { columnName: "region", dataType: "varchar(16)", rowCount: 9, generatorKey: "text", isTag: true },
    ],
  });

  const state = createTableGenerateState(config, "tdengine");
  assert.equal(state.shouldAddTbname, true);
  assert.ok(state.tbname);

  const tagValues = new Set<unknown>();
  const tbnames = new Set<unknown>();
  let total = 0;
  for (;;) {
    const rows = generateTableRowsChunk(config, state, 4);
    if (rows.length === 0) break;
    for (const row of rows) {
      assert.equal(row.length, 3); // tbname + ts + region
      tbnames.add(row[0]);
      tagValues.add(row[2]);
      total++;
    }
  }

  assert.equal(total, 9);
  assert.equal(tbnames.size, 1);
  assert.equal(tagValues.size, 1); // tag is generated once and reused
  assert.equal(state.colNames[0], "tbname");
});

test("buildGenerateInsertStatements merges mysql rows into one multi-row INSERT", () => {
  const config = makeConfig({ rowCount: 3 });
  const state = createTableGenerateState(config, "mysql");
  const statements = buildGenerateInsertStatements("mysql", state, ["(1, 'a')", "(2, 'b')", "(3, 'c')"]);

  assert.equal(statements.length, 1);
  assert.match(statements[0], /^INSERT INTO /);
  assert.match(statements[0], /VALUES\n\(1, 'a'\),\n\(2, 'b'\),\n\(3, 'c'\);$/);
});

test("buildGenerateInsertStatements falls back to one statement per row without multi-row support", () => {
  const config = makeConfig({ rowCount: 2 });
  const state = createTableGenerateState(config, "iris");
  const statements = buildGenerateInsertStatements("iris", state, ["(1, 'a')", "(2, 'b')"]);

  assert.equal(statements.length, 2);
  assert.match(statements[0], / VALUES \(1, 'a'\);$/);
  assert.match(statements[1], / VALUES \(2, 'b'\);$/);
});

test("buildGenerateInsertStatements honours forceSingleRow and empty input", () => {
  const config = makeConfig();
  const state = createTableGenerateState(config, "mysql");

  assert.deepEqual(buildGenerateInsertStatements("mysql", state, [], false), []);
  assert.deepEqual(buildGenerateInsertStatements("mysql", state, [], true), []);

  const forced = buildGenerateInsertStatements("mysql", state, ["(1, 'a')", "(2, 'b')"], true);
  assert.equal(forced.length, 2);
});

test("splitValueRowsByByteBudget keeps every group within the budget", () => {
  const config = makeConfig();
  const state = createTableGenerateState(config, "mysql");
  const valueRows = ["(1, 'a')", "(2, 'b')", "(3, 'c')", "(4, 'd')"];

  // Budget that only fits the prefix plus one row forces per-row grouping.
  const prefixBytes = state.insertPrefix.length + 4;
  const groups = splitValueRowsByByteBudget(state, valueRows, prefixBytes + 12);

  assert.ok(groups.length > 1);
  for (const group of groups) {
    const bytes = state.insertPrefix.length + 4 + group.reduce((sum, values) => sum + values.length + 4, 0);
    assert.ok(bytes <= prefixBytes + 12, `group exceeds budget: ${bytes}`);
  }
  assert.deepEqual(groups.flat(), valueRows);
});

test("splitValueRowsByByteBudget keeps an oversized single row in its own group", () => {
  const config = makeConfig();
  const state = createTableGenerateState(config, "mysql");
  const huge = `(${"x".repeat(500)})`;

  const groups = splitValueRowsByByteBudget(state, [huge, "(2, 'b')"], 64);
  assert.equal(groups.length, 2);
  assert.equal(groups[0][0], huge);
  assert.equal(groups[1][0], "(2, 'b')");
});

test("splitValueRowsByByteBudget handles degenerate inputs", () => {
  const config = makeConfig();
  const state = createTableGenerateState(config, "mysql");

  assert.deepEqual(splitValueRowsByByteBudget(state, [], 1024), []);
  // maxBytes <= 0 disables splitting and returns a single group.
  assert.deepEqual(splitValueRowsByByteBudget(state, ["(1, 'a')", "(2, 'b')"], 0), [["(1, 'a')", "(2, 'b')"]]);
  assert.deepEqual(splitValueRowsByByteBudget(state, ["(1, 'a')"], -5), [["(1, 'a')"]]);
});
