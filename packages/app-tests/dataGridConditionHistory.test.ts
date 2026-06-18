import { strict as assert } from "node:assert";
import { beforeEach, test } from "vitest";
import { forgetDataGridConditionHistory, loadDataGridConditionHistory, rememberDataGridConditionHistory } from "../../apps/desktop/src/lib/dataGridConditionHistory.ts";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
  });
});

test("remembers table-scoped WHERE history with newest entries first", () => {
  const scope = { connectionId: "c1", database: "app", schema: "public", tableName: "users" };

  rememberDataGridConditionHistory("where", scope, "status = 'active'");
  rememberDataGridConditionHistory("where", scope, "created_at > '2026-01-01'");
  rememberDataGridConditionHistory("where", scope, "status = 'active'");

  assert.deepEqual(loadDataGridConditionHistory("where", scope), ["status = 'active'", "created_at > '2026-01-01'"]);
});

test("keeps WHERE and ORDER BY histories separate", () => {
  const scope = { connectionId: "c1", database: "app", schema: "public", tableName: "users" };

  rememberDataGridConditionHistory("where", scope, "status = 'active'");
  rememberDataGridConditionHistory("orderBy", scope, "created_at DESC");

  assert.deepEqual(loadDataGridConditionHistory("where", scope), ["status = 'active'"]);
  assert.deepEqual(loadDataGridConditionHistory("orderBy", scope), ["created_at DESC"]);
});

test("filters history by partial input and isolates different tables", () => {
  const users = { connectionId: "c1", database: "app", schema: "public", tableName: "users" };
  const orders = { connectionId: "c1", database: "app", schema: "public", tableName: "orders" };

  rememberDataGridConditionHistory("where", users, "status = 'active'");
  rememberDataGridConditionHistory("where", users, "email LIKE '%@example.com'");
  rememberDataGridConditionHistory("where", orders, "status = 'paid'");

  assert.deepEqual(loadDataGridConditionHistory("where", users, "email"), ["email LIKE '%@example.com'"]);
  assert.deepEqual(loadDataGridConditionHistory("where", orders), ["status = 'paid'"]);
});

test("forgets a single condition without clearing other scoped history", () => {
  const scope = { connectionId: "c1", database: "app", schema: "public", tableName: "users" };

  rememberDataGridConditionHistory("where", scope, "status = 'active'");
  rememberDataGridConditionHistory("where", scope, "email LIKE '%@example.com'");
  rememberDataGridConditionHistory("orderBy", scope, "created_at DESC");

  assert.deepEqual(forgetDataGridConditionHistory("where", scope, "status = 'active'"), ["email LIKE '%@example.com'"]);
  assert.deepEqual(loadDataGridConditionHistory("where", scope), ["email LIKE '%@example.com'"]);
  assert.deepEqual(loadDataGridConditionHistory("orderBy", scope), ["created_at DESC"]);
});
