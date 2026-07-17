import assert from "node:assert/strict";
import { test } from "vitest";
import { buildDeploySqlForObjects, convertToSchemaDiffObjects, schemaDiffDeployTargetSchema, type TableDiff } from "../../apps/desktop/src/lib/schema/schemaDiff.ts";

test("uses generated sync SQL for modified table deployment", () => {
  const tableDiffs: TableDiff[] = [
    {
      type: "modified",
      objectType: "table",
      name: "users",
      ddl: "CREATE TABLE `users` (`name` varchar(64));",
      syncSql: "-- Alter table: users\nALTER TABLE `users`\n  MODIFY COLUMN `name` varchar(128) NOT NULL;",
      columns: [
        {
          type: "modified",
          name: "name",
          changes: ["type: varchar(64) -> varchar(128)"],
        },
      ],
    },
  ];

  const objects = convertToSchemaDiffObjects(tableDiffs);
  const deploySql = buildDeploySqlForObjects(objects);

  assert.equal(
    deploySql,
    "-- Alter table: users\nALTER TABLE `users`\n  MODIFY COLUMN `name` varchar(128) NOT NULL;\n",
  );
  assert.equal(deploySql.includes("CREATE TABLE"), false);
});

test("falls back to source DDL when object sync SQL is unavailable", () => {
  const tableDiffs: TableDiff[] = [
    {
      type: "added",
      objectType: "table",
      name: "users",
      ddl: "CREATE TABLE `users` (`id` int);",
    },
  ];

  const objects = convertToSchemaDiffObjects(tableDiffs);

  assert.equal(buildDeploySqlForObjects(objects), "-- Create table: users\nCREATE TABLE `users` (`id` int);\n");
});

test("uses mysql target database as schema diff deploy qualifier", () => {
  assert.equal(schemaDiffDeployTargetSchema("mysql", "target_db", ""), "target_db");
  assert.equal(schemaDiffDeployTargetSchema("mysql", "target_db", "  "), "target_db");
  assert.equal(schemaDiffDeployTargetSchema("mysql", "target_db", "explicit_schema"), "explicit_schema");
  assert.equal(schemaDiffDeployTargetSchema("sqlite", "main", ""), undefined);
});
