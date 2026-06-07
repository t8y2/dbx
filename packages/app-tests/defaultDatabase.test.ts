import assert from "node:assert/strict";
import test from "node:test";
import { isDefaultDatabase, resolveDefaultDatabase } from "../../apps/desktop/src/lib/defaultDatabase.ts";

test("优先使用连接上已保存的默认数据库", () => {
  assert.equal(resolveDefaultDatabase({ database: "analytics" }, ["app", "analytics"]), "analytics");
});

test("默认数据库为空时回退到首个可选数据库", () => {
  assert.equal(resolveDefaultDatabase({ database: undefined }, ["app", "analytics"]), "app");
});

test("没有默认数据库且无候选项时返回空字符串", () => {
  assert.equal(resolveDefaultDatabase({ database: undefined }, []), "");
});

test("判断当前数据库是否为默认数据库", () => {
  assert.equal(isDefaultDatabase({ database: "analytics" }, "analytics"), true);
  assert.equal(isDefaultDatabase({ database: "analytics" }, "app"), false);
  assert.equal(isDefaultDatabase(undefined, "analytics"), false);
  assert.equal(isDefaultDatabase({ database: "analytics" }, ""), false);
});
