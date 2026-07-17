import assert from "node:assert/strict";
import { test } from "vitest";
import { evaluateSqlSafety, splitSqlStatements, sqlSafetyFromEnv } from "../src/sql-safety.js";
import { supportsHashLineComments } from "../src/sql-risk.js";

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

// --- Dialect-aware `#` comment handling ---

test("supportsHashLineComments matches Rust mysql-compatible dialect set", () => {
  for (const dbType of ["mysql", "doris", "starrocks", "manticoresearch", "goldendb"]) {
    assert.equal(supportsHashLineComments(dbType), true, dbType);
  }
  for (const dbType of ["postgres", "sqlite", "sqlserver", "oracle", "duckdb", "bigquery", "redshift", ""]) {
    assert.equal(supportsHashLineComments(dbType), false, dbType);
  }
  assert.equal(supportsHashLineComments(undefined), false);
});

test("splitSqlStatements splits PG `#` operator correctly (hashLineComments omitted/default)", () => {
  assert.deepEqual(splitSqlStatements("SELECT a # b; SELECT 2"), ["SELECT a # b", "SELECT 2"]);
});

test("splitSqlStatements splits PG `#` operator correctly (hashLineComments: false)", () => {
  assert.deepEqual(splitSqlStatements("SELECT a # b; SELECT 2", { hashLineComments: false }), [
    "SELECT a # b",
    "SELECT 2",
  ]);
});

test("splitSqlStatements treats `#` as comment with hashLineComments: true (MySQL)", () => {
  // With hashLineComments: true, the `;` inside the `#` comment must NOT split.
  // The comment text is preserved in the output (splitter only delimits on `;`, it doesn't strip).
  assert.deepEqual(
    splitSqlStatements("SELECT 1; # trailing ; comment\nSELECT 2", { hashLineComments: true }),
    ["SELECT 1", "# trailing ; comment\nSELECT 2"],
  );
});

test("splitSqlStatements preserves JSONB operator text verbatim", () => {
  const result = splitSqlStatements("SELECT data #>> '{a,b}' FROM t");
  assert.equal(result.length, 1);
  assert.equal(result[0], "SELECT data #>> '{a,b}' FROM t");
});

test("splitSqlStatements handles `#` as operator mid-statement (PG)", () => {
  assert.deepEqual(splitSqlStatements("SELECT 1 # 2; DELETE FROM t"), [
    "SELECT 1 # 2",
    "DELETE FROM t",
  ]);
});

test("evaluateSqlSafety blocks PG injection that bypasses # as comment (regression)", () => {
  // Before fix: # would strip "2; DELETE FROM t" as comment, classify as read-only.
  // After fix: # is treated as an operator, so DELETE FROM t is seen as a second write statement.
  const decision = evaluateSqlSafety("SELECT 1 # 2; DELETE FROM t", {
    allowWrites: false,
    allowMultipleStatements: true,
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /read-only/i);
});

test("evaluateSqlSafety allows MySQL `#` comment with hashLineComments: true", () => {
  const decision = evaluateSqlSafety("SELECT 1 # delete note", {
    allowWrites: false,
    allowMultipleStatements: true,
    hashLineComments: true,
  });
  assert.equal(decision.allowed, true);
});

test("evaluateSqlSafety with hashLineComments: false still sees DELETE after `#` operator", () => {
  const decision = evaluateSqlSafety("SELECT 1 # 2; DELETE FROM t", {
    allowWrites: false,
    allowMultipleStatements: true,
    hashLineComments: false,
  });
  assert.equal(decision.allowed, false);
});
