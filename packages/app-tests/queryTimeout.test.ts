import { strict as assert } from "node:assert";
import test from "node:test";
import { DEFAULT_QUERY_TIMEOUT_SECS, queryTimeoutSecsForConnection } from "../../apps/desktop/src/lib/queryTimeout.ts";

test("uses default query timeout when connection has no setting", () => {
  assert.equal(queryTimeoutSecsForConnection(undefined), DEFAULT_QUERY_TIMEOUT_SECS);
  assert.equal(queryTimeoutSecsForConnection({}), DEFAULT_QUERY_TIMEOUT_SECS);
});

test("preserves long query timeout settings", () => {
  assert.equal(queryTimeoutSecsForConnection({ query_timeout_secs: 600 }), 600);
  assert.equal(queryTimeoutSecsForConnection({ query_timeout_secs: 3600 }), 3600);
});

test("allows zero to disable query timeout", () => {
  assert.equal(queryTimeoutSecsForConnection({ query_timeout_secs: 0 }), 0);
});
