import assert from "node:assert/strict";
import { test } from "vitest";
import { buildHunks } from "../../apps/desktop/src/components/diff/DiffHunkBuilder.ts";

function realLineTypes(sourceDdl: string, targetDdl: string): Map<string, string> {
  const types = new Map<string, string>();
  for (const hunk of buildHunks(sourceDdl, targetDdl)) {
    for (const line of hunk.leftLines) {
      if (!line.isPadding) types.set(`left:${line.content.trim()}`, line.type);
    }
    for (const line of hunk.rightLines) {
      if (!line.isPadding) types.set(`right:${line.content.trim()}`, line.type);
    }
  }
  return types;
}

test("aligns reordered DDL fields only when their identifiers match", () => {
  const sourceDdl = [
    "CREATE TABLE `skills` (",
    "  `id` bigint(20) NOT NULL AUTO_INCREMENT,",
    "  `allowed_tools` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,",
    "  `content` longtext COLLATE utf8mb4_unicode_ci,",
    "  `created_at` bigint(20) DEFAULT NULL,",
    "  `description` varchar(1024) COLLATE utf8mb4_unicode_ci NOT NULL,",
    "  `model` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,",
    "  `name` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,",
    "  `status` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,",
    "  `version` int(11) NOT NULL DEFAULT '0'",
    ");",
  ].join("\n");
  const targetDdl = [
    "CREATE TABLE `skills` (",
    "  `id` bigint(20) NOT NULL AUTO_INCREMENT,",
    "  `name` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,",
    "  `description` varchar(1024) COLLATE utf8mb4_unicode_ci NOT NULL,",
    "  `content` longtext COLLATE utf8mb4_unicode_ci,",
    "  `allowed_tools` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,",
    "  `model` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,",
    "  `status` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'draft',",
    "  `version` int(11) NOT NULL DEFAULT '0'",
    ");",
  ].join("\n");

  const hunks = buildHunks(sourceDdl, targetDdl);
  const modifiedPairs = hunks.filter((hunk) => hunk.type === "modify").map((hunk) => [hunk.leftLines[0].content.trim(), hunk.rightLines[0].content.trim()]);

  assert.deepEqual(modifiedPairs, [["`status` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,", "`status` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'draft',"]]);

  const types = realLineTypes(sourceDdl, targetDdl);
  assert.equal(types.get("left:`created_at` bigint(20) DEFAULT NULL,"), "delete");
  assert.equal(types.get("left:`name` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,"), "equal");
  assert.equal(types.get("right:`name` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,"), "equal");
});

test("does not show an unchanged field as deleted when only its position changes", () => {
  const sourceDdl = [
    "CREATE TABLE `skills` (",
    "  `content` longtext,",
    "  `created_at` bigint(20) DEFAULT NULL,",
    "  `created_by` varchar(128) DEFAULT NULL,",
    "  `description` varchar(1024) NOT NULL,",
    "  `name` varchar(64) NOT NULL,",
    "  `skill_id` bigint(20) NOT NULL,",
    "  `version` int(11) NOT NULL,",
    "  `markdown` longtext,",
    "  `model` varchar(128) DEFAULT NULL",
    ");",
  ].join("\n");
  const targetDdl = [
    "CREATE TABLE `skills` (",
    "  `content` longtext,",
    "  `created_by` varchar(128) DEFAULT NULL,",
    "  `description` varchar(1024) NOT NULL,",
    "  `name` varchar(64) NOT NULL,",
    "  `skill_id` bigint(20) NOT NULL,",
    "  `version` int(11) NOT NULL,",
    "  `created_at` bigint(20) DEFAULT NULL,",
    "  `markdown` longtext,",
    "  `model` varchar(128) DEFAULT NULL",
    ");",
  ].join("\n");

  const types = realLineTypes(sourceDdl, targetDdl);
  assert.equal(types.get("left:`created_at` bigint(20) DEFAULT NULL,"), "equal");
  assert.equal(types.get("right:`created_at` bigint(20) DEFAULT NULL,"), "equal");
});

test("shows a moved field as modified when its definition also changes", () => {
  const source = ["`created_at` bigint(20) DEFAULT NULL,", "`name` varchar(64) NOT NULL"].join("\n");
  const target = ["`name` varchar(64) NOT NULL", "`created_at` bigint(20) NOT NULL"].join("\n");
  const hunks = buildHunks(source, target);
  const createdAtLines = hunks.flatMap((hunk) => [...hunk.leftLines, ...hunk.rightLines]).filter((line) => !line.isPadding && line.content.includes("`created_at`"));

  assert.deepEqual(
    createdAtLines.map((line) => line.type),
    ["modify", "modify"],
  );
  assert.deepEqual(
    createdAtLines.map((line) => line.comparisonContent),
    ["`created_at` bigint(20) NOT NULL", "`created_at` bigint(20) DEFAULT NULL,"],
  );
});

test.each([
  ["MySQL", "`name`", "`status`"],
  ["PostgreSQL", '"name"', '"status"'],
  ["SQL Server", "[name]", "[status]"],
])("does not mark different %s column identifiers as modified", (_database, sourceColumn, targetColumn) => {
  const hunks = buildHunks(`${sourceColumn} varchar(64) NOT NULL`, `${targetColumn} varchar(64) NOT NULL`);

  assert.equal(
    hunks.some((hunk) => hunk.type === "modify"),
    false,
  );
  assert.deepEqual(
    hunks.map((hunk) => hunk.type),
    ["delete", "insert"],
  );
});

test("keeps a same-name constraint aligned when its definition changes", () => {
  const source = '  CONSTRAINT "fk_orders_user" FOREIGN KEY ("user_id") REFERENCES "users" ("id")';
  const target = '  CONSTRAINT "fk_orders_user" FOREIGN KEY ("user_id") REFERENCES "accounts" ("id")';
  const hunks = buildHunks(source, target);

  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].type, "modify");
});

test("does not align different named indexes by their shared definition", () => {
  for (const [source, target] of [
    ["  UNIQUE KEY `idx_users_email` (`email`)", "  UNIQUE KEY `idx_accounts_email` (`email`)"],
    ["  FULLTEXT KEY `idx_users_bio` (`bio`)", "  FULLTEXT KEY `idx_accounts_bio` (`bio`)"],
    ['CREATE UNIQUE INDEX "idx_users_email" ON "users" ("email")', 'CREATE UNIQUE INDEX "idx_accounts_email" ON "users" ("email")'],
  ]) {
    const hunks = buildHunks(source, target);
    assert.equal(
      hunks.some((hunk) => hunk.type === "modify"),
      false,
    );
  }
});

test("distinguishes quoted keyword columns from SQL clause lines", () => {
  const columnHunks = buildHunks('  "select" varchar(64)', '  "from" varchar(64)');
  const clauseHunks = buildHunks("SELECT name", "FROM users");

  assert.equal(
    columnHunks.some((hunk) => hunk.type === "modify"),
    false,
  );
  assert.equal(
    clauseHunks.some((hunk) => hunk.type === "modify"),
    false,
  );
});

test("keeps large rewritten DDL blocks bounded and identity-safe", () => {
  const source = Array.from({ length: 600 }, (_, index) => `  \`source_${index}\` varchar(255) DEFAULT NULL`).join("\n");
  const target = Array.from({ length: 600 }, (_, index) => `  \`target_${index}\` varchar(255) DEFAULT NULL`).join("\n");
  const hunks = buildHunks(source, target);

  assert.equal(
    hunks.some((hunk) => hunk.type === "modify"),
    false,
  );
});
