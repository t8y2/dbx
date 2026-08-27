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

test("keeps a modified table with a removed index out of the delete group", () => {
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

  const groups = groupDiffObjects(objects);
  const deleteGroup = groups.find((group) => group.operationType === "delete");
  const modifyGroup = groups.find((group) => group.operationType === "modify");

  // The table exists on both sides, so it must only be classified as a
  // structural modification — never as an object to delete on the target.
  assert.deepEqual(
    deleteGroup?.typeGroups.map((group) => group.kind),
    [],
  );
  assert.equal(deleteGroup?.count, 0);
  assert.deepEqual(
    modifyGroup?.typeGroups.map((group) => ({ kind: group.kind, names: group.objects.map((object) => object.name) })),
    [{ kind: "table", names: ["users"] }],
  );

  const table = modifyGroup?.typeGroups[0]?.objects[0];
  assert.equal(table?.sourceDdl, objects[0].sourceDdl);
  assert.equal(table?.targetDdl, objects[0].targetDdl);
  // The destructive child stays visible under the table drill-down.
  assert.equal(table?.children?.[0].id, "idx-users-idx_users_email");
  assert.equal(table?.children?.[0].operationType, "delete");
  assert.equal(summarizeSchemaDiffOperations(objects).delete, 1);
});

test("issue 7225: both-side table with DDL differences is never a delete candidate", () => {
  const objects = convertToSchemaDiffObjects([
    {
      type: "modified",
      objectType: "table",
      name: "shared_orders",
      ddl: "CREATE TABLE `shared_orders` (`order_no` varchar(64) COMMENT 'order number', `remark` varchar(255));",
      targetDdl: "CREATE TABLE `shared_orders` (`order_no` varchar(64) COMMENT 'order no', KEY `idx_amount` (`amount`));",
      syncSql: "ALTER TABLE `shared_orders` MODIFY COLUMN `order_no` varchar(64) COMMENT 'order number', ADD COLUMN `remark` varchar(255); DROP INDEX `idx_amount` ON `shared_orders`;",
      columns: [
        { type: "modified", name: "order_no", changes: ["comment: order no -> order number"] },
        { type: "added", name: "remark" },
      ],
      indexes: [{ type: "removed", name: "idx_amount" }],
    },
  ]);

  const groups = groupDiffObjects(objects);

  // Structural comparison happens under "modify"; the delete/create groups
  // must stay reserved for presence differences.
  for (const operationType of ["create", "delete"] as const) {
    const group = groups.find((candidate) => candidate.operationType === operationType);
    assert.deepEqual(group?.typeGroups, []);
    assert.equal(group?.count, 0);
  }
  const modifyGroup = groups.find((group) => group.operationType === "modify");
  assert.deepEqual(
    modifyGroup?.typeGroups.map((group) => group.objects.map((object) => object.name)),
    [["shared_orders"]],
  );

  const table = modifyGroup?.typeGroups[0]?.objects[0];
  assert.equal(table?.id, "table-shared_orders");
  assert.equal(table?.sourceName, "shared_orders");
  assert.equal(table?.targetName, "shared_orders");
  assert.ok(table?.sourceDdl);
  assert.ok(table?.targetDdl);
  assert.deepEqual(
    table?.children?.map((child) => `${child.objectKind}:${child.name}:${child.operationType}`),
    ["column:order_no:modify", "column:remark:create", "index:idx_amount:delete"],
  );
  assert.deepEqual(summarizeSchemaDiffOperations(objects), { create: 1, modify: 1, delete: 1, none: 0 });
});

test("classifies identical, source-only and target-only tables by presence", () => {
  const objects = convertToSchemaDiffObjects([
    { type: "none", objectType: "table", name: "identical" },
    { type: "added", objectType: "table", name: "source_only" },
    { type: "removed", objectType: "table", name: "target_only" },
  ]);

  const groups = groupDiffObjects(objects);
  const namesFor = (operationType: string) =>
    groups
      .find((group) => group.operationType === operationType)
      ?.typeGroups.flatMap((typeGroup) => typeGroup.objects.map((object) => object.name));

  assert.deepEqual(namesFor("modify"), []);
  assert.deepEqual(namesFor("create"), ["source_only"]);
  assert.deepEqual(namesFor("delete"), ["target_only"]);
  assert.deepEqual(namesFor("none"), ["identical"]);
});

test("case-different table names stay presence-based on case-sensitive servers", () => {
  const objects = convertToSchemaDiffObjects([
    { type: "added", objectType: "table", name: "Users" },
    { type: "removed", objectType: "table", name: "users" },
  ]);

  const groups = groupDiffObjects(objects);
  const namesFor = (operationType: string) =>
    groups
      .find((group) => group.operationType === operationType)
      ?.typeGroups.flatMap((typeGroup) => typeGroup.objects.map((object) => object.name));

  assert.deepEqual(namesFor("create"), ["Users"]);
  assert.deepEqual(namesFor("delete"), ["users"]);
  assert.deepEqual(namesFor("modify"), []);
});

test("keeps ordinary child changes under the modified table", () => {
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
  // The table exists on both sides: create/delete groups must not list it.
  assert.deepEqual(createGroup?.typeGroups, []);
  assert.deepEqual(deleteGroup?.typeGroups, []);

  const table = modifyGroup?.typeGroups[0]?.objects[0];
  assert.deepEqual(
    table?.children?.map((child) => `${child.objectKind}:${child.name}:${child.operationType}`),
    ["column:name:modify", "column:nickname:create", "index:idx_legacy:delete"],
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
  // The destructive children stay under the modified table; the delete group
  // only lists target-only objects.
  assert.equal(deleteGroup?.count, 0);
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
