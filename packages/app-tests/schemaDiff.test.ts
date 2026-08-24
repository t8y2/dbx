import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildDeploySqlForObjects,
  convertToSchemaDiffObjects,
  detectDestructiveSchemaDiffStatements,
  groupDiffObjects,
  schemaDiffDeployTargetSchema,
  schemaDiffReviewAlert,
  selectSchemaDiffInput,
  setSchemaDiffObjectSelected,
  setSchemaDiffObjectSelectedWithDependencies,
  summarizeSchemaDiffOperations,
  type TableDiff,
} from "../../apps/desktop/src/lib/schema/schemaDiff.ts";

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

  assert.equal(deploySql, "-- Alter table: users\nALTER TABLE `users`\n  MODIFY COLUMN `name` varchar(128) NOT NULL;\n");
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

test("shows a modified table with a removed index once in the delete group", () => {
  const objects = convertToSchemaDiffObjects([
    {
      type: "modified",
      objectType: "table",
      name: "users",
      ddl: "CREATE TABLE `users` (`email` varchar(255), KEY `idx_users_email` (`email`));",
      targetDdl: "CREATE TABLE `users` (`email` varchar(255));",
      syncSql: "DROP INDEX `idx_users_email` ON `users`;",
      indexes: [{ type: "removed", name: "idx_users_email" }],
    },
  ]);

  const deleteGroup = groupDiffObjects(objects).find((group) => group.operationType === "delete");
  const tables = deleteGroup?.typeGroups.find((group) => group.kind === "table")?.objects ?? [];

  assert.equal(tables.length, 1);
  assert.equal(tables[0].name, "users");
  assert.equal(tables[0].sourceDdl, objects[0].sourceDdl);
  assert.equal(tables[0].targetDdl, objects[0].targetDdl);
  assert.equal(tables[0].children?.[0].id, "idx-users-idx_users_email");
  assert.equal(deleteGroup?.count, 1);
  assert.equal(summarizeSchemaDiffOperations(objects).delete, 1);
});

test("keeps ordinary child changes under the modified table while surfacing delete risks", () => {
  const objects = convertToSchemaDiffObjects([
    {
      type: "modified",
      objectType: "table",
      name: "users",
      syncSql: "ALTER TABLE `users` MODIFY COLUMN `name` varchar(128), ADD COLUMN `nickname` varchar(64), DROP INDEX `idx_legacy`;",
      columns: [
        { type: "modified", name: "name" },
        { type: "added", name: "nickname" },
      ],
      indexes: [{ type: "removed", name: "idx_legacy" }],
    },
  ]);

  const groups = groupDiffObjects(objects);
  const modifyGroup = groups.find((group) => group.operationType === "modify");
  const createGroup = groups.find((group) => group.operationType === "create");
  const deleteGroup = groups.find((group) => group.operationType === "delete");

  assert.deepEqual(
    modifyGroup?.typeGroups.map((group) => ({ kind: group.kind, names: group.objects.map((object) => object.name) })),
    [{ kind: "table", names: ["users"] }],
  );
  assert.deepEqual(
    createGroup?.typeGroups.map((group) => ({ kind: group.kind, names: group.objects.map((object) => object.name) })),
    [{ kind: "table", names: ["users"] }],
  );
  assert.deepEqual(
    deleteGroup?.typeGroups.map((group) => ({ kind: group.kind, names: group.objects.map((object) => object.name) })),
    [{ kind: "table", names: ["users"] }],
  );

  assert.deepEqual(summarizeSchemaDiffOperations(objects), { create: 1, modify: 1, delete: 1, none: 0 });
});

test("surfaces a modified index as delete risk because deployment drops it first", () => {
  const objects = convertToSchemaDiffObjects([
    {
      type: "modified",
      objectType: "table",
      name: "users",
      syncSql: "DROP INDEX `idx_users_email` ON `users`;\nCREATE UNIQUE INDEX `idx_users_email` ON `users` (`email`);",
      indexes: [{ type: "modified", name: "idx_users_email", changes: ["unique: NO -> YES"] }],
    },
  ]);

  const index = objects[0].children?.find((child) => child.objectKind === "index");
  assert.equal(index?.operationType, "delete");
  assert.equal(summarizeSchemaDiffOperations(objects).delete, 1);
});

test("surfaces a modified foreign key as delete risk because deployment drops it first", () => {
  const objects = convertToSchemaDiffObjects([
    {
      type: "modified",
      objectType: "table",
      name: "orders",
      syncSql: "ALTER TABLE `orders` DROP FOREIGN KEY `fk_orders_user`;",
      foreignKeys: [{ type: "modified", name: "fk_orders_user", changes: ["onDelete: RESTRICT -> CASCADE"] }],
    },
  ]);

  const foreignKey = objects[0].children?.find((child) => child.objectKind === "foreignKey");
  assert.equal(foreignKey?.operationType, "delete");
  assert.equal(summarizeSchemaDiffOperations(objects).delete, 1);
});

test("counts each selectable destructive child under its table context", () => {
  const objects = convertToSchemaDiffObjects([
    {
      type: "modified",
      objectType: "table",
      name: "orders",
      syncSql: "ALTER TABLE `orders` DROP COLUMN `legacy_code`, DROP INDEX `idx_legacy`, DROP FOREIGN KEY `fk_legacy`;",
      columns: [{ type: "removed", name: "legacy_code" }],
      indexes: [{ type: "removed", name: "idx_legacy" }],
      foreignKeys: [{ type: "removed", name: "fk_legacy" }],
    },
  ]);

  const deleteGroup = groupDiffObjects(objects).find((group) => group.operationType === "delete");
  assert.equal(deleteGroup?.count, 3);
  assert.deepEqual(
    deleteGroup?.typeGroups.map((group) => group.kind),
    ["table"],
  );
  assert.deepEqual(summarizeSchemaDiffOperations(objects), { create: 0, modify: 0, delete: 3, none: 0 });
});

test("does not double count children when an entire table is deleted", () => {
  const objects = convertToSchemaDiffObjects([
    {
      type: "removed",
      objectType: "table",
      name: "legacy_users",
      columns: [{ type: "removed", name: "id" }],
      indexes: [{ type: "removed", name: "idx_legacy_users_id" }],
    },
  ]);

  const counts = summarizeSchemaDiffOperations(objects);
  const deleteGroup = groupDiffObjects(objects).find((group) => group.operationType === "delete");
  assert.equal(counts.delete, 1);
  assert.equal(deleteGroup?.count, 1);
  assert.deepEqual(
    deleteGroup?.typeGroups.map((group) => group.kind),
    ["table"],
  );
});

test("clearing an index preserves independently selected column changes", () => {
  const result = {
    diffs: [
      {
        type: "modified",
        objectType: "table",
        name: "users",
        syncSql: "ALTER TABLE `users` DROP INDEX `idx_users_email`, ADD COLUMN `nickname` varchar(64);",
        columns: [{ type: "added", name: "nickname" }],
        indexes: [{ type: "removed", name: "idx_users_email" }],
      },
    ] satisfies TableDiff[],
    syncSql: "",
  };
  const objects = convertToSchemaDiffObjects(result.diffs);

  assert.equal(setSchemaDiffObjectSelected(objects, "idx-users-idx_users_email", false), true);
  assert.equal(objects[0].selected, false);
  assert.equal(objects[0].children?.find((child) => child.id === "col-users-nickname")?.selected, true);

  const selected = selectSchemaDiffInput(result, objects);
  assert.deepEqual(
    selected.diffs[0].columns?.map((column) => column.name),
    ["nickname"],
  );
  assert.deepEqual(selected.diffs[0].indexes, []);
});

test("new and removed tables remain atomic deploy units", () => {
  const result = {
    diffs: [
      {
        type: "added",
        objectType: "table",
        name: "audit_log",
        columns: [{ type: "added", name: "id" }],
        indexes: [{ type: "added", name: "PRIMARY" }],
      },
    ] satisfies TableDiff[],
    syncSql: "",
  };
  const objects = convertToSchemaDiffObjects(result.diffs);

  assert.equal(objects[0].children, undefined);
  assert.equal(selectSchemaDiffInput(result, objects).diffs.length, 1);
  setSchemaDiffObjectSelected(objects, objects[0].id, false);
  assert.equal(selectSchemaDiffInput(result, objects).diffs.length, 0);
});

test("table option selection is projected independently from field changes", () => {
  const result = {
    diffs: [
      {
        type: "modified",
        objectType: "table",
        name: "users",
        columns: [{ type: "modified", name: "name" }],
        sourceTableComment: "new comment",
        targetTableComment: "old comment",
      },
    ] satisfies TableDiff[],
    syncSql: "",
  };
  const objects = convertToSchemaDiffObjects(result.diffs);
  setSchemaDiffObjectSelected(objects, "table-option-users", false);

  const selected = selectSchemaDiffInput(result, objects).diffs[0];
  assert.equal(selected.sourceTableComment, undefined);
  assert.equal(selected.targetTableComment, undefined);
  assert.deepEqual(
    selected.columns?.map((column) => column.name),
    ["name"],
  );
});

test("index selection keeps added-column and AFTER dependencies visible and selected", () => {
  const result = {
    diffs: [
      {
        type: "modified",
        objectType: "table",
        name: "users",
        columns: [
          { type: "added", name: "nickname" },
          { type: "added", name: "nickname_key", addPosition: { after: "nickname" } },
        ],
        indexes: [
          {
            type: "added",
            name: "idx_nickname_key",
            source: { name: "idx_nickname_key", columns: ["nickname_key"], is_unique: false, is_primary: false },
          },
        ],
      },
    ] satisfies TableDiff[],
    syncSql: "",
  };
  const objects = convertToSchemaDiffObjects(result.diffs);

  setSchemaDiffObjectSelectedWithDependencies(objects, result, "col-users-nickname", false);
  assert.equal(objects[0].children?.find((child) => child.id === "col-users-nickname_key")?.selected, false);
  assert.equal(objects[0].children?.find((child) => child.id === "idx-users-idx_nickname_key")?.selected, false);

  setSchemaDiffObjectSelectedWithDependencies(objects, result, "idx-users-idx_nickname_key", true);
  assert.equal(objects[0].children?.find((child) => child.id === "col-users-nickname")?.selected, true);
  assert.equal(objects[0].children?.find((child) => child.id === "col-users-nickname_key")?.selected, true);
});

test("detects destructive schema diff statements without comment or string false positives", () => {
  const destructive = detectDestructiveSchemaDiffStatements(
    ["-- DROP TABLE audit_log", "SELECT 'DROP INDEX idx_fake' AS message", 'ALTER TABLE "DROP INDEX audit" ADD COLUMN note text', "DROP INDEX IF EXISTS idx_users_email", "ALTER TABLE users DROP COLUMN legacy_code, DROP INDEX idx_legacy"].join(";\n"),
    "postgres",
  );

  assert.deepEqual(
    destructive.map(({ objectType }) => objectType),
    ["INDEX", "COLUMN", "INDEX"],
  );
});

test("does not classify compatibility warnings as destructive when no delete SQL is selected", () => {
  assert.equal(schemaDiffReviewAlert(0, 58), "compatibility");
  assert.equal(schemaDiffReviewAlert(1, 58), "destructive");
  assert.equal(schemaDiffReviewAlert(0, 0), null);
});
