import assert from "node:assert/strict";
import { test } from "vitest";
import { evaluateSqlSafety, splitSqlStatements, sqlSafetyFromEnv } from "../src/sql-safety.js";

test("allows read-only SQL by default", () => {
  const decision = evaluateSqlSafety("select * from users limit 5");

  assert.equal(decision.allowed, true);
});

test("allows read-only EXPLAIN without ANALYZE", () => {
  const decision = evaluateSqlSafety("EXPLAIN SELECT * FROM users");

  assert.equal(decision.allowed, true);
});

test("allows non-dangerous write SQL by default when scoped", () => {
  const decision = evaluateSqlSafety("update users set role = 'admin' where id = 1", sqlSafetyFromEnv({}));

  assert.equal(decision.allowed, true);
});

test("blocks dangerous SQL even when writes are enabled", () => {
  const decision = evaluateSqlSafety("drop table users", { allowWrites: true });

  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /dangerous/i);
});

test("blocks update without where when writes are enabled", () => {
  const decision = evaluateSqlSafety("update users set disabled = true", { allowWrites: true });

  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /WHERE/i);
});

test("blocks writes that do not start with a write keyword in read-only mode", () => {
  for (const sql of [
    "EXPLAIN ANALYZE DELETE FROM users WHERE id = 1",
    "/*! DELETE FROM users WHERE id = 1 */",
    "COPY users FROM '/tmp/users.csv'",
    "SELECT * INTO backup_users FROM users",
    "SELECT * FROM users INTO OUTFILE '/tmp/users.csv'",
  ]) {
    const decision = evaluateSqlSafety(sql);
    assert.equal(decision.allowed, false, sql);
    assert.match(decision.reason ?? "", /read-only|blocked/i);
  }
});

test("blocks unrecognized SQL unless dangerous SQL is explicitly enabled", () => {
  const decision = evaluateSqlSafety("MAINTAIN UNKNOWN THING", { allowWrites: true });

  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /unrecognized/i);
});

test("blocks multiple SQL statements unless explicitly allowed", () => {
  const decision = evaluateSqlSafety("select 1; select 2");

  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /Only one SQL statement/);
});

test("allows multiple read-only SQL statements when enabled", () => {
  const decision = evaluateSqlSafety("select 1; show tables", { allowMultipleStatements: true });

  assert.equal(decision.allowed, true);
});

test("checks every statement in a multi-statement SQL string", () => {
  const decision = evaluateSqlSafety("select 1; delete from users", {
    allowMultipleStatements: true,
    allowWrites: true,
  });

  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /Statement 2/i);
  assert.match(decision.reason ?? "", /WHERE/i);
});

test("splits statements without altering SQL literals or comments", () => {
  const sql = "SELECT 'a;b' AS value, ''abc'' AS quoted; -- keep comment\nSELECT $$c;d$$ AS dollar;";

  assert.deepEqual(splitSqlStatements(sql), [
    "SELECT 'a;b' AS value, ''abc'' AS quoted",
    "-- keep comment\nSELECT $$c;d$$ AS dollar",
  ]);
});

test("keeps tagged dollar quotes and quoted identifiers intact", () => {
  const sql = 'SELECT $body$begin; end$body$ AS body, "semi;colon" AS "quoted;column"; SELECT 2;';

  assert.deepEqual(splitSqlStatements(sql), [
    'SELECT $body$begin; end$body$ AS body, "semi;colon" AS "quoted;column"',
    "SELECT 2",
  ]);
});

test("sqlSafetyFromEnv allows writes by default but keeps dangerous SQL blocked", () => {
  const options = sqlSafetyFromEnv({});

  assert.equal(options.allowWrites, true);
  assert.equal(options.allowDangerous, false);
});

test("sqlSafetyFromEnv supports explicitly disabling writes", () => {
  const options = sqlSafetyFromEnv({ DBX_MCP_ALLOW_WRITES: "0" } as NodeJS.ProcessEnv);

  assert.equal(options.allowWrites, false);
  assert.equal(options.allowDangerous, false);
});
