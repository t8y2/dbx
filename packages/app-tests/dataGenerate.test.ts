import { strict as assert } from "node:assert";
import { test } from "vitest";
import { defaultGeneratorParams, displayGeneratedValue, generateTableData, generateValue } from "../../apps/desktop/src/lib/dataGrid/dataGenerate.ts";

test("enables default values for columns with schema defaults", () => {
  const params = defaultGeneratorParams(
    "status",
    {
      dataType: "varchar(16)",
      columnDefault: "active",
    },
    "text",
  );

  assert.equal(params.includeDefault, true);
  assert.equal(params.defaultPercent, 100);
});

test("uses string column defaults instead of random generated values", () => {
  const result = generateTableData(
    {
      tableName: "users",
      schema: "public",
      database: "app",
      rowCount: 2,
      columns: [
        {
          columnName: "status",
          dataType: "varchar(16)",
          rowCount: 2,
          generatorKey: "text",
          generatorParams: { includeDefault: true, defaultPercent: 100 },
          columnDefault: "active",
        },
      ],
    },
    "postgres",
  );

  assert.deepEqual(result.rows, [["active"], ["active"]]);
  assert.match(result.sql, /VALUES\n\('active'\),\n\('active'\);$/);
});

test("unwraps quoted and casted PostgreSQL default literals", () => {
  const result = generateTableData(
    {
      tableName: "users",
      schema: "public",
      database: "app",
      rowCount: 1,
      columns: [
        {
          columnName: "role",
          dataType: "text",
          rowCount: 1,
          generatorKey: "text",
          generatorParams: { includeDefault: true, defaultPercent: 100 },
          columnDefault: "'guest'::text",
        },
      ],
    },
    "postgres",
  );

  assert.deepEqual(result.rows, [["guest"]]);
  assert.match(result.sql, /VALUES\n\('guest'\);$/);
});

test("keeps expression defaults as raw SQL", () => {
  const result = generateTableData(
    {
      tableName: "events",
      schema: "public",
      database: "app",
      rowCount: 2,
      columns: [
        {
          columnName: "created_at",
          dataType: "timestamp",
          rowCount: 2,
          generatorKey: "datetime",
          generatorParams: { includeDefault: true, defaultPercent: 100 },
          columnDefault: "CURRENT_TIMESTAMP",
        },
      ],
    },
    "postgres",
  );

  assert.equal(displayGeneratedValue(result.rows[0][0]), "CURRENT_TIMESTAMP");
  assert.match(result.sql, /VALUES\n\(CURRENT_TIMESTAMP\),\n\(CURRENT_TIMESTAMP\);$/);
  assert.doesNotMatch(result.sql, /'CURRENT_TIMESTAMP'/);
});

test("includeDefault without a schema default no longer emits NULL", () => {
  const value = generateValue("name", "varchar(32)", "text", 0, { includeDefault: true, defaultPercent: 100 });

  assert.notEqual(value, null);
  assert.notEqual(value, undefined);
});
