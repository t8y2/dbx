import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildDataGridRollbackStatements,
  buildDataGridSaveStatements,
  dataGridSaveExecutionSchema,
  normalizeDataGridSaveError,
  validateDataGridSave,
} from "../src/lib/dataGridSql.ts";
import { DBX_NEO4J_ELEMENT_ID_COLUMN } from "../src/lib/tableEditing.ts";

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

test("builds Hive grid save statements with backtick identifiers", () => {
  const statements = buildDataGridSaveStatements({
    databaseType: "hive",
    tableMeta: {
      tableName: "department states",
      primaryKeys: ["dept id"],
    },
    columns: ["dept id", "display name"],
    rows: [[10, "Sales"]],
    dirtyRows: [[0, [[1, "Marketing"]]]],
    deletedRows: [0],
    newRows: [[20, "Engineering"]],
  });

  assert.deepEqual(statements, [
    "UPDATE `department states` SET `display name` = 'Marketing' WHERE `dept id` = 10;",
    "DELETE FROM `department states` WHERE `dept id` = 10;",
    "INSERT INTO `department states` (`dept id`, `display name`) VALUES (20, 'Engineering');",
  ]);
});

test("builds Hive grid save statements without primary keys using row predicates", () => {
  const statements = buildDataGridSaveStatements({
    databaseType: "hive",
    tableMeta: {
      tableName: "departments",
      primaryKeys: [],
    },
    columns: ["id", "name", "location"],
    rows: [[10, "Sales", null]],
    dirtyRows: [[0, [[1, "Marketing"]]]],
    deletedRows: [0],
    newRows: [],
  });

  assert.deepEqual(statements, [
    "UPDATE `departments` SET `name` = 'Marketing' WHERE `id` = 10 AND `name` = 'Sales' AND `location` IS NULL;",
    "DELETE FROM `departments` WHERE `id` = 10 AND `name` = 'Sales' AND `location` IS NULL;",
  ]);
});

test("builds Trino insert statements with schema-qualified identifiers", () => {
  const statements = buildDataGridSaveStatements({
    databaseType: "trino",
    tableMeta: {
      schema: "tiny",
      tableName: "nation",
      primaryKeys: [],
    },
    columns: ["nationkey", "name"],
    rows: [],
    dirtyRows: [],
    deletedRows: [],
    newRows: [[100, "Atlantis"]],
  });

  assert.deepEqual(statements, ['INSERT INTO "tiny"."nation" ("nationkey", "name") VALUES (100, \'Atlantis\');']);
});

test("builds Informix grid save statements without delimited identifiers", () => {
  const statements = buildDataGridSaveStatements({
    databaseType: "informix",
    tableMeta: {
      schema: "testdb",
      tableName: "dbx_grid_edit_probe",
      primaryKeys: ["id"],
    },
    columns: ["id", "name"],
    rows: [[1, "before"]],
    dirtyRows: [[0, [[1, "after"]]]],
    deletedRows: [0],
    newRows: [[2, "new"]],
  });

  assert.deepEqual(statements, [
    "UPDATE dbx_grid_edit_probe SET name = 'after' WHERE id = 1;",
    "DELETE FROM dbx_grid_edit_probe WHERE id = 1;",
    "INSERT INTO dbx_grid_edit_probe (id, name) VALUES (2, 'new');",
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

test("builds Neo4j grid save statements with elementId keys", () => {
  const statements = buildDataGridSaveStatements({
    databaseType: "neo4j",
    tableMeta: {
      tableName: "Employee",
      primaryKeys: [DBX_NEO4J_ELEMENT_ID_COLUMN],
    },
    columns: [DBX_NEO4J_ELEMENT_ID_COLUMN, "name", "active"],
    rows: [["4:abc:7", "Ada", true]],
    dirtyRows: [[0, [[1, "Grace"]]]],
    deletedRows: [0],
    newRows: [[null, "Linus", false]],
  });

  assert.deepEqual(statements, [
    "MATCH (n:`Employee`) WHERE elementId(n) = '4:abc:7' SET n.`name` = 'Grace';",
    "MATCH (n:`Employee`) WHERE elementId(n) = '4:abc:7' DETACH DELETE n;",
    "CREATE (n:`Employee` {`name`: 'Linus', `active`: FALSE});",
  ]);
});

test("builds best-effort Neo4j rollback statements", () => {
  const statements = buildDataGridRollbackStatements({
    databaseType: "neo4j",
    tableMeta: {
      tableName: "Employee",
      primaryKeys: [DBX_NEO4J_ELEMENT_ID_COLUMN],
    },
    columns: [DBX_NEO4J_ELEMENT_ID_COLUMN, "name", "active"],
    rows: [["4:abc:7", "Ada", true]],
    dirtyRows: [[0, [[1, "Grace"]]]],
    deletedRows: [0],
    newRows: [[null, "Linus", false]],
  });

  assert.deepEqual(statements, [
    "MATCH (n:`Employee`) WHERE n.`name` = 'Linus' AND n.`active` = FALSE DETACH DELETE n;",
    "CREATE (n:`Employee` {`name`: 'Ada', `active`: TRUE});",
    "MATCH (n:`Employee`) WHERE elementId(n) = '4:abc:7' SET n.`name` = 'Ada';",
  ]);
});

test("skips schema setup for Neo4j data grid saves", () => {
  assert.equal(
    dataGridSaveExecutionSchema("neo4j", { schema: "ignored", tableName: "Employee", primaryKeys: [] }),
    undefined,
  );
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

test("normalizes Hive ACID update and delete errors", () => {
  const error = normalizeDataGridSaveError(
    "hive",
    "Statement 1 failed: Agent RPC error (-1): Error while compiling statement: FAILED: SemanticException [Error 10294]: Attempt to do update or delete using transaction manager that does not support these operations.. Previous 0 statement(s) may have been committed.",
  );

  assert.equal(
    error,
    "Hive UPDATE/DELETE are not enabled for this table or server. Add rows with INSERT, or enable ACID transactional tables in Hive before editing/deleting existing rows.",
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

test("allows NULL for MySQL auto increment columns when inserting rows", () => {
  const error = validateDataGridSave({
    databaseType: "mysql",
    tableMeta: {
      tableName: "people",
      primaryKeys: ["id"],
    },
    columns: ["id", "name"],
    rows: [],
    columnInfo: [
      { name: "id", is_nullable: false, column_default: null, is_primary_key: true, extra: "auto_increment" },
      { name: "name", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
    ],
    dirtyRows: [],
    newRows: [[null, "Ada"]],
  });

  assert.equal(error, undefined);
});

test("rejects inserted rows that duplicate existing primary key values", () => {
  const error = validateDataGridSave({
    databaseType: "postgres",
    tableMeta: {
      tableName: "education_data",
      primaryKeys: ["country_code", "year"],
    },
    columns: ["country_code", "year", "value"],
    rows: [["ALB", 2021, 0.812]],
    columnInfo: [
      { name: "country_code", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "year", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "value", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ],
    dirtyRows: [],
    newRows: [["ALB", 2021, 0.812]],
  });

  assert.equal(
    error,
    'New row duplicates the existing primary key (country_code = "ALB", year = 2021). Change the key before saving.',
  );
});

test("rejects inserted rows that duplicate another new row primary key", () => {
  const error = validateDataGridSave({
    databaseType: "postgres",
    tableMeta: {
      tableName: "education_data",
      primaryKeys: ["country_code", "year"],
    },
    columns: ["country_code", "year", "value"],
    rows: [],
    columnInfo: [
      { name: "country_code", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "year", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "value", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ],
    dirtyRows: [],
    newRows: [
      ["ALB", 2021, 0.812],
      ["ALB", 2021, 0.913],
    ],
  });

  assert.equal(
    error,
    'New row duplicates another new row\'s primary key (country_code = "ALB", year = 2021). Change the key before saving.',
  );
});
