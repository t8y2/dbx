import { strict as assert } from "node:assert";
import { beforeEach, test } from "vitest";
import { forgetRedisKeySearchHistory, loadRedisKeySearchHistory, rememberRedisKeySearchHistory } from "../../apps/desktop/src/lib/redis/redisKeySearchHistory.ts";

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

test("remembers connection+db+mode scoped search history with newest entries first", () => {
  const scope = { connectionId: "c1", db: 0, searchMode: "key" as const };

  rememberRedisKeySearchHistory(scope, "user:*");
  rememberRedisKeySearchHistory(scope, "session:*");
  rememberRedisKeySearchHistory(scope, "user:*");

  assert.deepEqual(loadRedisKeySearchHistory(scope), ["user:*", "session:*"]);
});

test("does not store empty or whitespace-only patterns", () => {
  const scope = { connectionId: "c1", db: 0, searchMode: "key" as const };

  rememberRedisKeySearchHistory(scope, "user:*");
  rememberRedisKeySearchHistory(scope, "");
  rememberRedisKeySearchHistory(scope, "   ");

  assert.deepEqual(loadRedisKeySearchHistory(scope), ["user:*"]);
});

test("keeps key/value/all histories separate and isolates connections and databases", () => {
  const keyScope = { connectionId: "c1", db: 0, searchMode: "key" as const };
  const valueScope = { connectionId: "c1", db: 0, searchMode: "value" as const };
  const otherDb = { connectionId: "c1", db: 1, searchMode: "key" as const };
  const otherConnection = { connectionId: "c2", db: 0, searchMode: "key" as const };

  rememberRedisKeySearchHistory(keyScope, "user:*");
  rememberRedisKeySearchHistory(valueScope, "active");
  rememberRedisKeySearchHistory(otherDb, "cache:*");
  rememberRedisKeySearchHistory(otherConnection, "order:*");

  assert.deepEqual(loadRedisKeySearchHistory(keyScope), ["user:*"]);
  assert.deepEqual(loadRedisKeySearchHistory(valueScope), ["active"]);
  assert.deepEqual(loadRedisKeySearchHistory(otherDb), ["cache:*"]);
  assert.deepEqual(loadRedisKeySearchHistory(otherConnection), ["order:*"]);
});

test("keeps the newest 20 history entries", () => {
  const scope = { connectionId: "c1", db: 0, searchMode: "key" as const };

  for (let index = 1; index <= 21; index += 1) {
    rememberRedisKeySearchHistory(scope, `pattern ${index}`);
  }

  assert.deepEqual(
    loadRedisKeySearchHistory(scope),
    Array.from({ length: 20 }, (_, index) => `pattern ${21 - index}`),
  );
});

test("filters history by partial input", () => {
  const scope = { connectionId: "c1", db: 0, searchMode: "key" as const };

  rememberRedisKeySearchHistory(scope, "user:*");
  rememberRedisKeySearchHistory(scope, "session:*");
  rememberRedisKeySearchHistory(scope, "user:admin:*");

  assert.deepEqual(loadRedisKeySearchHistory(scope, "user"), ["user:admin:*", "user:*"]);
});

test("forgets a single pattern without clearing other scoped history", () => {
  const scope = { connectionId: "c1", db: 0, searchMode: "key" as const };
  const other = { connectionId: "c1", db: 0, searchMode: "value" as const };

  rememberRedisKeySearchHistory(scope, "user:*");
  rememberRedisKeySearchHistory(scope, "session:*");
  rememberRedisKeySearchHistory(other, "active");

  assert.deepEqual(forgetRedisKeySearchHistory(scope, "user:*"), ["session:*"]);
  assert.deepEqual(loadRedisKeySearchHistory(scope), ["session:*"]);
  assert.deepEqual(loadRedisKeySearchHistory(other), ["active"]);
});
