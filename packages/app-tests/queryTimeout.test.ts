import { strict as assert } from "node:assert";
import { test } from "vitest";
import { DEFAULT_QUERY_TIMEOUT_SECS, frontendQueryTimeoutSecsForSql, queryTimeoutSecsForConnection } from "../../apps/desktop/src/lib/sql/queryTimeout.ts";

test("queryTimeoutSecsForConnection falls back to the default timeout", () => {
  assert.equal(DEFAULT_QUERY_TIMEOUT_SECS, 60);
  assert.equal(queryTimeoutSecsForConnection(undefined), DEFAULT_QUERY_TIMEOUT_SECS);
  assert.equal(queryTimeoutSecsForConnection({ query_timeout_secs: -1 }), DEFAULT_QUERY_TIMEOUT_SECS);
  assert.equal(queryTimeoutSecsForConnection({ query_timeout_secs: 0 }), 0);
  assert.equal(queryTimeoutSecsForConnection({ query_timeout_secs: 15 }), 15);
});

test("frontend query timeout scales with SQL statement count", () => {
  assert.equal(frontendQueryTimeoutSecsForSql("INSERT INTO users VALUES (1)", "mysql", 30), 60);
  assert.equal(frontendQueryTimeoutSecsForSql("INSERT INTO users VALUES (1); INSERT INTO users VALUES (2);", "mysql", 30), 120);
  assert.equal(frontendQueryTimeoutSecsForSql("INSERT INTO users VALUES (1); INSERT INTO users VALUES (2); INSERT INTO users VALUES (3);", "mysql", 10), 180);
  assert.equal(frontendQueryTimeoutSecsForSql("/* prep */\nINSERT INTO users VALUES (1);\n-- keep batching\nINSERT INTO users VALUES (2);", "mysql", 30), 120);
  assert.equal(frontendQueryTimeoutSecsForSql("INSERT INTO users VALUES (1); INSERT INTO users VALUES (2);", "mysql", 0), 0);
});
