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

test("remembers connection+db scoped search history with newest entries first", () => {
  const scope = { connectionId: "c1", db: 0 };

  rememberRedisKeySearchHistory(scope, "queue_update");
  rememberRedisKeySearchHistory(scope, "insert");
  rememberRedisKeySearchHistory(scope, "queue_update");

  assert.deepEqual(loadRedisKeySearchHistory(scope), ["queue_update", "insert"]);
});

test("does not store empty or whitespace-only patterns", () => {
  const scope = { connectionId: "c1", db: 0 };

  rememberRedisKeySearchHistory(scope, "queue_update");
  rememberRedisKeySearchHistory(scope, "");
  rememberRedisKeySearchHistory(scope, "   ");

  assert.deepEqual(loadRedisKeySearchHistory(scope), ["queue_update"]);
});

test("shares history across search modes and isolates connections and databases", () => {
  const scope = { connectionId: "c1", db: 0 };
  const otherDb = { connectionId: "c1", db: 1 };
  const otherConnection = { connectionId: "c2", db: 0 };

  rememberRedisKeySearchHistory(scope, "queue_update");
  rememberRedisKeySearchHistory(scope, "insert");
  rememberRedisKeySearchHistory(otherDb, "cache:*");
  rememberRedisKeySearchHistory(otherConnection, "order:*");

  assert.deepEqual(loadRedisKeySearchHistory(scope), ["insert", "queue_update"]);
  assert.deepEqual(loadRedisKeySearchHistory(otherDb), ["cache:*"]);
  assert.deepEqual(loadRedisKeySearchHistory(otherConnection), ["order:*"]);
});

test("keeps the newest 20 history entries", () => {
  const scope = { connectionId: "c1", db: 0 };

  for (let index = 1; index <= 21; index += 1) {
    rememberRedisKeySearchHistory(scope, `pattern ${index}`);
  }

  assert.deepEqual(
    loadRedisKeySearchHistory(scope),
    Array.from({ length: 20 }, (_, index) => `pattern ${21 - index}`),
  );
});

test("filters history by partial input when a query is provided", () => {
  const scope = { connectionId: "c1", db: 0 };

  rememberRedisKeySearchHistory(scope, "queue_update");
  rememberRedisKeySearchHistory(scope, "insert");
  rememberRedisKeySearchHistory(scope, "queue_update:pending");

  assert.deepEqual(loadRedisKeySearchHistory(scope, "queue"), ["queue_update:pending", "queue_update"]);
  assert.deepEqual(loadRedisKeySearchHistory(scope), ["queue_update:pending", "insert", "queue_update"]);
});

test("forgets a single pattern without clearing other scoped history", () => {
  const scope = { connectionId: "c1", db: 0 };
  const other = { connectionId: "c1", db: 1 };

  rememberRedisKeySearchHistory(scope, "queue_update");
  rememberRedisKeySearchHistory(scope, "insert");
  rememberRedisKeySearchHistory(other, "active");

  assert.deepEqual(forgetRedisKeySearchHistory(scope, "queue_update"), ["insert"]);
  assert.deepEqual(loadRedisKeySearchHistory(scope), ["insert"]);
  assert.deepEqual(loadRedisKeySearchHistory(other), ["active"]);
});
