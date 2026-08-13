import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { DEFAULT_QUERY_TIMEOUT_SECS, frontendQueryTimeoutSecsForSql, queryTimeoutSecsForConnection } from "../../apps/desktop/src/lib/sql/queryTimeout.ts";

const contentAreaSource = readFileSync("apps/desktop/src/components/layout/ContentArea.vue", "utf8");

test("queryTimeoutSecsForConnection falls back to the default timeout", () => {
  assert.equal(DEFAULT_QUERY_TIMEOUT_SECS, 30);
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

test("query timeout actions target the connection that produced the result", () => {
  const resultErrorActions = [...contentAreaSource.matchAll(/<QueryErrorActions[\s\S]*?\/>/g)].map((match) => match[0]).filter((tag) => tag.includes(':backend-error="activeTab.result.error"'));

  assert.equal(resultErrorActions.length, 2);
  for (const tag of resultErrorActions) {
    assert.match(tag, /:connection-id="activeResultConnectionId"/);
    assert.match(tag, /emit\('openConnectionSettings', activeResultConnectionId, 'advanced'\)/);
    assert.doesNotMatch(tag, /activeTab\.connectionId/);
  }
});
