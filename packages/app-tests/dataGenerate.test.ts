import { strict as assert } from "node:assert";
import { test, vi } from "vitest";
import { defaultGeneratorParams, displayGeneratedValue, findGeneratorKey, generateTableData, generateValue, supportsGeneratedMultiRowValues } from "../../apps/desktop/src/lib/dataGrid/dataGenerate.ts";

test("recognizes Oracle-compatible NUMBER column types as numeric", () => {
  assert.equal(findGeneratorKey("value", "NUMBER"), "number");
  assert.equal(findGeneratorKey("value", "NUMBER(10)"), "number");
  assert.equal(findGeneratorKey("value", "NUMBER(18, 2)"), "number");
  assert.equal(findGeneratorKey("value", "NUMBER(10)", true), "sequence");
  assert.equal(findGeneratorKey("value", "serial_number_code"), "text");
  assert.equal(findGeneratorKey("value", "NUMBER CODE"), "text");
});

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

test("fails before producing SQL when an explicitly unique generator is exhausted", () => {
  assert.throws(
    () =>
      generateTableData(
        {
          tableName: "users",
          schema: "public",
          database: "app",
          rowCount: 2,
          columns: [
            {
              columnName: "status",
              dataType: "text",
              rowCount: 2,
              generatorKey: "enum",
              generatorParams: { values: "active", unique: true },
            },
          ],
        },
        "postgres",
      ),
    /unique value.*status.*users/i,
  );
});

test("retries collisions for an explicitly unique generator", () => {
  const random = vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(0.99);
  try {
    const result = generateTableData(
      {
        tableName: "users",
        schema: "public",
        database: "app",
        rowCount: 2,
        columns: [
          {
            columnName: "rank",
            dataType: "integer",
            rowCount: 2,
            generatorKey: "number",
            generatorParams: { min: 1, max: 2, unique: true },
          },
        ],
      },
      "postgres",
    );

    assert.deepEqual(result.rows, [[1], [2]]);
  } finally {
    random.mockRestore();
  }
});

test("keeps explicit uniqueness scoped independently to each column", () => {
  const result = generateTableData(
    {
      tableName: "pairs",
      schema: "public",
      database: "app",
      rowCount: 2,
      columns: ["left_id", "right_id"].map((columnName) => ({
        columnName,
        dataType: "integer",
        rowCount: 2,
        generatorKey: "sequence",
        generatorParams: { startValue: 1, increment: 1, unique: true },
      })),
    },
    "postgres",
  );

  assert.deepEqual(result.rows, [
    [1, 1],
    [2, 2],
  ]);
});

test("keeps duplicate values unchanged when explicit uniqueness is disabled", () => {
  const result = generateTableData(
    {
      tableName: "users",
      schema: "public",
      database: "app",
      rowCount: 2,
      columns: [
        {
          columnName: "status",
          dataType: "text",
          rowCount: 2,
          generatorKey: "enum",
          generatorParams: { values: "active", unique: false },
        },
      ],
    },
    "postgres",
  );

  assert.deepEqual(result.rows, [["active"], ["active"]]);
});

test("generates 1000 distinct emails when explicit uniqueness is enabled", () => {
  const result = generateTableData(
    {
      tableName: "users",
      schema: "public",
      database: "app",
      rowCount: 1000,
      columns: [
        {
          columnName: "email",
          dataType: "text",
          rowCount: 1000,
          generatorKey: "email",
          generatorParams: { unique: true },
        },
      ],
    },
    "postgres",
  );

  assert.equal(new Set(result.rows.map((row) => row[0])).size, 1000);
});

test("treats repeated null, default, and SQL expression values as unique-domain exhaustion", () => {
  const cases = [
    {
      columnName: "optional_name",
      dataType: "text",
      generatorKey: "text",
      generatorParams: { includeNull: true, nullPercent: 100, unique: true },
    },
    {
      columnName: "status",
      dataType: "text",
      generatorKey: "text",
      generatorParams: { includeDefault: true, defaultPercent: 100, unique: true },
      columnDefault: "active",
    },
    {
      columnName: "created_at",
      dataType: "timestamp",
      generatorKey: "datetime",
      generatorParams: { includeDefault: true, defaultPercent: 100, unique: true },
      columnDefault: "CURRENT_TIMESTAMP",
    },
  ];

  for (const column of cases) {
    assert.throws(
      () =>
        generateTableData(
          {
            tableName: "events",
            schema: "public",
            database: "app",
            rowCount: 2,
            columns: [{ ...column, rowCount: 2 }],
          },
          "postgres",
        ),
      new RegExp(`unique value.*${column.columnName}.*events`, "i"),
    );
  }
});

test("generates Oracle-compatible single-row inserts with explicit temporal literals", () => {
  const result = generateTableData(
    {
      tableName: "DBX_GENERATE_TEST",
      schema: "APP",
      database: "XE",
      rowCount: 2,
      columns: [
        {
          columnName: "ID",
          dataType: "NUMBER",
          rowCount: 2,
          generatorKey: "sequence",
          generatorParams: { startValue: 1, increment: 1 },
        },
        {
          columnName: "CREATED_ON",
          dataType: "DATE",
          rowCount: 2,
          generatorKey: "date",
        },
        {
          columnName: "CREATED_AT",
          dataType: "TIMESTAMP(6)",
          rowCount: 2,
          generatorKey: "datetime",
        },
      ],
    },
    "oracle",
  );

  assert.equal(supportsGeneratedMultiRowValues("oracle"), false);
  assert.equal(result.statements.length, 1);
  assert.match(result.statements[0], /^INSERT ALL\n/);
  assert.equal(result.statements[0].match(/\n  INTO /g)?.length, 2);
  assert.match(result.statements[0], /SELECT 1 FROM DUAL;$/);
  assert.ok(result.statements.every((sql) => /TO_DATE\('[^']+', 'YYYY-MM-DD'\)/.test(sql)));
  assert.ok(result.statements.every((sql) => /TO_TIMESTAMP\('[^']+', 'YYYY-MM-DD HH24:MI:SS'\)/.test(sql)));
  assert.doesNotMatch(result.sql, /VALUES\s*\([^;]+\),\s*\(/s);
});

test("batches large Oracle data generation statements", () => {
  const result = generateTableData(
    {
      tableName: "DBX_GENERATE_TEST",
      schema: "APP",
      database: "XE",
      rowCount: 101,
      columns: [
        {
          columnName: "ID",
          dataType: "NUMBER",
          rowCount: 101,
          generatorKey: "sequence",
          generatorParams: { startValue: 1, increment: 1, unique: true },
        },
      ],
    },
    "oracle",
  );

  assert.equal(result.statements.length, 2);
  assert.equal(result.statements[0].match(/\n  INTO /g)?.length, 100);
  assert.equal(result.statements[1].match(/\n  INTO /g)?.length, 1);
});

test("generates TDengine stable rows with one child table identity and stable tag values", () => {
  const result = generateTableData(
    {
      tableName: "sensor_data",
      tableType: "STABLE",
      schema: "dbx_issue4512",
      database: "dbx_issue4512",
      rowCount: 2,
      columns: [
        {
          columnName: "ts",
          dataType: "TIMESTAMP",
          rowCount: 2,
          generatorKey: "sequence",
          generatorParams: { startValue: 1, increment: 1 },
        },
        {
          columnName: "temperature",
          dataType: "FLOAT",
          rowCount: 2,
          generatorKey: "sequence",
          generatorParams: { startValue: 20, increment: 1 },
        },
        {
          columnName: "device_id",
          dataType: "BINARY(64)",
          rowCount: 2,
          generatorKey: "sequence",
          generatorParams: { startValue: 100, increment: 1, unique: true },
          isTag: true,
        },
      ],
    },
    "tdengine",
  );

  assert.deepEqual(result.columns, ["tbname", "ts", "temperature", "device_id"]);
  assert.match(String(result.rows[0][0]), /^dbx_gen_[a-z0-9]+_[a-z0-9]+$/);
  assert.equal(result.rows[1][0], result.rows[0][0]);
  assert.deepEqual(
    result.rows.map((row) => row.slice(1)),
    [
      [1, 20, 100],
      [2, 21, 100],
    ],
  );
  assert.match(result.sql, /^INSERT INTO `sensor_data` \(`tbname`, `ts`, `temperature`, `device_id`\) VALUES\n/);
  assert.equal(result.sql.match(/'dbx_gen_[a-z0-9]+_[a-z0-9]+'/g)?.length, 2);
});

test("keeps ordinary TDengine table generation unchanged", () => {
  const result = generateTableData(
    {
      tableName: "sensor_data_001",
      tableType: "TABLE",
      schema: "dbx_issue4512",
      database: "dbx_issue4512",
      rowCount: 1,
      columns: [
        {
          columnName: "ts",
          dataType: "TIMESTAMP",
          rowCount: 1,
          generatorKey: "sequence",
          generatorParams: { startValue: 1, increment: 1 },
        },
      ],
    },
    "tdengine",
  );

  assert.deepEqual(result.columns, ["ts"]);
  assert.deepEqual(result.rows, [[1]]);
  assert.doesNotMatch(result.sql, /tbname/);
});
