import { strict as assert } from "node:assert";
import test from "node:test";
import {
  DATABASE_EXPORT_INSERT_BATCH_SIZE,
  DATABASE_EXPORT_ROW_LIMIT,
  buildExportPageSql,
  buildDatabaseSqlExport,
  buildInsertStatements,
  formatSqlLiteral,
} from "../src/lib/databaseExport.ts";

test("formats SQL literals for exported INSERT statements", () => {
  assert.equal(formatSqlLiteral(null), "NULL");
  assert.equal(formatSqlLiteral(42), "42");
  assert.equal(formatSqlLiteral(true), "TRUE");
  assert.equal(formatSqlLiteral("O'Hara"), "'O''Hara'");
});

test("builds batched INSERT statements for one exported table", () => {
  const statements = buildInsertStatements({
    qualifiedTableName: "`users`",
    columns: ["id", "name"],
    rows: [
      [1, "Ada"],
      [2, "O'Hara"],
      [3, "Linus"],
    ],
    quoteIdentifier: (name) => `\`${name}\``,
    batchSize: 2,
  });

  assert.deepEqual(statements, [
    "INSERT INTO `users` (`id`, `name`) VALUES (1, 'Ada'), (2, 'O''Hara');",
    "INSERT INTO `users` (`id`, `name`) VALUES (3, 'Linus');",
  ]);
});

test("builds capped export page queries", () => {
  assert.equal(
    buildExportPageSql({
      databaseType: "mysql",
      tableName: "users",
      limit: 500,
      offset: 1000,
    }),
    "SELECT * FROM `users` LIMIT 500 OFFSET 1000;",
  );

  assert.equal(
    buildExportPageSql({
      databaseType: "sqlserver",
      schema: "dbo",
      tableName: "accounts",
      limit: DATABASE_EXPORT_ROW_LIMIT,
    }),
    `SELECT TOP ${DATABASE_EXPORT_ROW_LIMIT} * FROM "dbo"."accounts"`,
  );
});

test("builds a database SQL export with DDL before data", () => {
  const sql = buildDatabaseSqlExport({
    databaseName: "app",
    exportedAt: new Date("2026-05-02T00:00:00.000Z"),
    rowLimitPerTable: DATABASE_EXPORT_ROW_LIMIT,
    tables: [
      {
        displayName: "users",
        qualifiedTableName: "`users`",
        ddl: "CREATE TABLE `users` (`id` int);",
        columns: ["id"],
        rows: [[1]],
        truncated: true,
      },
    ],
    quoteIdentifier: (name) => `\`${name}\``,
    insertBatchSize: DATABASE_EXPORT_INSERT_BATCH_SIZE,
  });

  assert.equal(
    sql,
    [
      "-- DBX database export",
      "-- Database: app",
      "-- Exported at: 2026-05-02T00:00:00.000Z",
      `-- Row limit per table: ${DATABASE_EXPORT_ROW_LIMIT}`,
      "",
      "-- Structure for users",
      "CREATE TABLE `users` (`id` int);",
      "",
      "-- Data for users",
      `-- Exported rows: 1 (truncated at ${DATABASE_EXPORT_ROW_LIMIT})`,
      "INSERT INTO `users` (`id`) VALUES (1);",
      "",
    ].join("\n"),
  );
});
