import assert from "node:assert/strict";
import { test } from "vitest";
import { TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE, decodeSelectableDatabaseValue, encodeSelectableDatabaseValue, formatDatabaseLabel, isDefaultDatabase, resolveDefaultDatabase } from "../../apps/desktop/src/lib/database/defaultDatabase.ts";

test("优先使用连接上已保存的默认数据库", () => {
  assert.equal(resolveDefaultDatabase({ database: "analytics" }, ["app", "analytics"]), "analytics");
});

test("默认数据库为空时回退到首个可选数据库", () => {
  assert.equal(resolveDefaultDatabase({ database: undefined }, ["app", "analytics"]), "app");
});

test("没有默认数据库且无候选项时返回空字符串", () => {
  assert.equal(resolveDefaultDatabase({ database: undefined }, []), "");
});

test("Cloudflare D1 使用 SQLite main 命名空间而不是连接凭据中的 Database ID", () => {
  assert.equal(resolveDefaultDatabase({ db_type: "cloudflare-d1", database: "d1-database-uuid" }, []), "main");
  assert.equal(isDefaultDatabase({ db_type: "cloudflare-d1", database: "d1-database-uuid" }, "main"), true);
  assert.equal(isDefaultDatabase({ db_type: "cloudflare-d1", database: "d1-database-uuid" }, "d1-database-uuid"), false);
});

test("判断当前数据库是否为默认数据库", () => {
  assert.equal(isDefaultDatabase({ database: "analytics" }, "analytics"), true);
  assert.equal(isDefaultDatabase({ database: "analytics" }, "app"), false);
  assert.equal(isDefaultDatabase(undefined, "analytics"), false);
  assert.equal(isDefaultDatabase({ database: "analytics" }, ""), false);
});

test("tree-schema 默认数据库会编码成可选中的稳定值并可解码回空字符串", () => {
  assert.equal(encodeSelectableDatabaseValue("saphana", ""), TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE);
  assert.equal(decodeSelectableDatabaseValue("saphana", TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE), "");
});

test("命名数据库保持原始值不变", () => {
  assert.equal(encodeSelectableDatabaseValue("saphana", "SALES"), "SALES");
  assert.equal(decodeSelectableDatabaseValue("saphana", "SALES"), "SALES");
});

test("数据库标签复用默认库显示语义", () => {
  assert.equal(formatDatabaseLabel({ db_type: "saphana" }, "", { defaultDatabase: "Default", noDatabase: "No database selected" }), "Default");
  assert.equal(
    formatDatabaseLabel({ db_type: "postgres" }, "analytics", {
      defaultDatabase: "Default",
      noDatabase: "No database selected",
    }),
    "analytics",
  );
  assert.equal(formatDatabaseLabel({ db_type: "redis" }, "3", { defaultDatabase: "Default", noDatabase: "No database selected" }), "db3");
});
