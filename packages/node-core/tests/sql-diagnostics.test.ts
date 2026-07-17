import assert from "node:assert/strict";
import { test } from "vitest";
import { logSqlDiagnostic, redactSqlForDiagnostics, sqlDiagnosticsEnabled } from "../src/sql-diagnostics.js";

test("SQL diagnostics are disabled unless explicitly enabled", () => {
  assert.equal(sqlDiagnosticsEnabled({}), false);
  assert.equal(sqlDiagnosticsEnabled({ DBX_SQL_DEBUG: "0" }), false);
  assert.equal(sqlDiagnosticsEnabled({ DBX_SQL_DEBUG: "1" }), true);
  assert.equal(sqlDiagnosticsEnabled({ DBX_MCP_DEBUG_SQL: "true" }), true);
});

test("redacts sensitive literals and bounds large SQL diagnostics", () => {
  const sql = `select * from users where password = 'secret-123' and token="tok-456" and api_key=plain ${"x".repeat(900)}`;
  const redacted = redactSqlForDiagnostics(sql);

  assert.doesNotMatch(redacted, /secret-123|tok-456|api_key=plain/);
  assert.match(redacted, /\[REDACTED\]/);
  assert.match(redacted, /api_key=\[REDACTED\]/);
  assert.match(redacted, /truncated/);
  assert.ok(redacted.length < sql.length);
});

test("disabled SQL diagnostic logging does not write statements", () => {
  const original = console.error;
  const messages: unknown[][] = [];
  console.error = (...args: unknown[]) => messages.push(args);
  try {
    logSqlDiagnostic("test", "select 'secret-123'", {}, {});
  } finally {
    console.error = original;
  }

  assert.equal(messages.length, 0);
});

test("enabled SQL diagnostic logging emits redacted statements only", () => {
  const original = console.error;
  const messages: unknown[][] = [];
  console.error = (...args: unknown[]) => messages.push(args);
  try {
    logSqlDiagnostic("test", "select 'secret-123' as password", {}, { DBX_SQL_DEBUG: "1" });
  } finally {
    console.error = original;
  }

  assert.equal(messages.length, 1);
  const rendered = messages.flat().join(" ");
  assert.doesNotMatch(rendered, /secret-123/);
  assert.match(rendered, /\[REDACTED\]/);
});

test("dollar-quoted strings are redacted", () => {
  const redacted = redactSqlForDiagnostics("select $$secret$$");
  assert.doesNotMatch(redacted, /secret/);
  assert.match(redacted, /\[REDACTED\]/);
});

test("space-separated sensitive assignments are redacted", () => {
  const redacted = redactSqlForDiagnostics("select * from t where password = mysecret");
  assert.doesNotMatch(redacted, /mysecret/);
  assert.match(redacted, /\[REDACTED\]/);
});

test("postgres positional parameters are not treated as dollar quotes ($1, $2, ...)", () => {
  const redacted = redactSqlForDiagnostics("select * from t where id = $1 and name = 'alice'");
  assert.match(redacted, /\$1\b/);
  assert.doesNotMatch(redacted, /alice/);
});

test("multiple postgres positional parameters all survive redaction", () => {
  const redacted = redactSqlForDiagnostics("select $1, $2, $3, $42 from t");
  assert.match(redacted, /\$1\b/);
  assert.match(redacted, /\$2\b/);
  assert.match(redacted, /\$3\b/);
  assert.match(redacted, /\$42\b/);
});

test("empty-tag dollar quote $$secret$$ is redacted", () => {
  const redacted = redactSqlForDiagnostics("select $$secret$$ from t");
  assert.match(redacted, /\$\$\[REDACTED\]\$\$/);
  assert.doesNotMatch(redacted, /secret/);
});

test("named-tag dollar quote $tag$hello$tag$ is redacted", () => {
  const redacted = redactSqlForDiagnostics("select $tag$hello$tag$ from t");
  assert.match(redacted, /\$\[REDACTED\]\$/);
  assert.doesNotMatch(redacted, /hello/);
});

test("lone trailing dollar sign does not throw and passes through", () => {
  const redacted = redactSqlForDiagnostics("select 1 $");
  assert.match(redacted, /\$/);
});

test("bounds redaction before scanning an unclosed literal", () => {
  const redacted = redactSqlForDiagnostics(`select '${"secret-".repeat(1000)}`, 32);
  assert.doesNotMatch(redacted, /secret-/);
  assert.match(redacted, /\[REDACTED\]/);
  assert.match(redacted, /truncated/);
});

test("does not leak a sensitive value cut at the diagnostic boundary", () => {
  const redacted = redactSqlForDiagnostics(`password = ${"secret-token".repeat(1000)}`, 24);
  assert.doesNotMatch(redacted, /secret-token|secret-/);
  assert.match(redacted, /password = \[REDACTED\]/);
  assert.match(redacted, /truncated/);
});
