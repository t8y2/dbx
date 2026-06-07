import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSqlSafety, sqlSafetyFromEnv } from "../src/sql-safety.js";

test("allows read-only SQL by default", () => {
  const decision = evaluateSqlSafety("select * from users limit 5");

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
