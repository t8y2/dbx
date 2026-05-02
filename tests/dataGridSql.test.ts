import { strict as assert } from "node:assert";
import test from "node:test";
import { buildDataGridSaveStatements } from "../src/lib/dataGridSql.ts";

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
    dirtyRows: [[0, [[1, "ready"], [2, "2026-05-04"]]]],
    deletedRows: [0],
    newRows: [[43, "new", "2026-05-05"]],
  });

  assert.deepEqual(statements, [
    "UPDATE [game].[player states] SET [state] = 'ready', [updated at] = '2026-05-04' WHERE [role id] = 42;",
    "DELETE FROM [game].[player states] WHERE [role id] = 42;",
    "INSERT INTO [game].[player states] ([role id], [state], [updated at]) VALUES (43, 'new', '2026-05-05');",
  ]);
});
