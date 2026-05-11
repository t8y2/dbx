import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildDataGridSaveStatements,
  dataGridSaveExecutionSchema,
  validateDataGridSave,
} from "../src/lib/dataGridSql.ts";

test("builds SQL Server grid save statements with schema and bracket quoting", () => {
  const statements = buildDataGridSaveStatements({
    databaseType: "sqlserver",
    tableMeta: {
      schema: "game",
      tableName: "player states",
      primaryKeys: ["role id"],
    },
    columns: ["role id", "state", "updated at"],
    rows: [[42, "old", "2026-05-03"]],
    dirtyRows: [
      [
        0,
        [
          [1, "ready"],
          [2, "2026-05-04"],
        ],
      ],
    ],
    deletedRows: [0],
    newRows: [[43, "new", "2026-05-05"]],
  });

  assert.deepEqual(statements, [
    "UPDATE [game].[player states] SET [state] = N'ready', [updated at] = N'2026-05-04' WHERE [role id] = 42;",
    "DELETE FROM [game].[player states] WHERE [role id] = 42;",
    "INSERT INTO [game].[player states] ([role id], [state], [updated at]) VALUES (43, N'new', N'2026-05-05');",
  ]);
});

test("uses Oracle ROWID as a synthetic key without writing it as a normal column", () => {
  const statements = buildDataGridSaveStatements({
    databaseType: "oracle",
    tableMeta: {
      schema: "DBXTEST",
      tableName: "DBX_LOAD_TABLE_006",
      primaryKeys: ["__DBX_ROWID"],
    },
    columns: ["__DBX_ROWID", "ID", "CITY", "NOTE"],
    rows: [["AAATiBAABAAABrXAAA", 1, "上海", "old"]],
    dirtyRows: [[0, [[2, "北京"]]]],
    deletedRows: [0],
    newRows: [[null, 2, "广州", "new"]],
  });

  assert.deepEqual(statements, [
    `UPDATE "DBXTEST"."DBX_LOAD_TABLE_006" SET "CITY" = '北京' WHERE ROWIDTOCHAR(ROWID) = 'AAATiBAABAAABrXAAA';`,
    `DELETE FROM "DBXTEST"."DBX_LOAD_TABLE_006" WHERE ROWIDTOCHAR(ROWID) = 'AAATiBAABAAABrXAAA';`,
    `INSERT INTO "DBXTEST"."DBX_LOAD_TABLE_006" ("ID", "CITY", "NOTE") VALUES (2, '广州', 'new');`,
  ]);
});

test("skips current_schema setup for Oracle data grid saves", () => {
  assert.equal(
    dataGridSaveExecutionSchema("oracle", { schema: "DBXTEST", tableName: "T", primaryKeys: [] }),
    undefined,
  );
  assert.equal(
    dataGridSaveExecutionSchema("postgres", { schema: "public", tableName: "T", primaryKeys: [] }),
    "public",
  );
});

test("rejects NULL writes to non-null table columns", () => {
  const error = validateDataGridSave({
    columns: ["ID", "CREATED_AT", "CITY"],
    columnInfo: [
      { name: "ID", is_nullable: false, is_primary_key: true },
      { name: "CREATED_AT", is_nullable: false, is_primary_key: false },
      { name: "CITY", is_nullable: true, is_primary_key: false },
    ],
    dirtyRows: [[0, [[1, null]]]],
    newRows: [[2, null, "上海"]],
  });

  assert.equal(error, 'Column "CREATED_AT" does not allow NULL.');
});
