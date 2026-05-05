import test from "node:test";
import assert from "node:assert/strict";
import { findStatementAtCursor } from "../src/lib/sqlStatementSplit.ts";

test("finds single statement", () => {
  assert.equal(findStatementAtCursor("SELECT 1", 3), "SELECT 1");
});

test("finds first statement before semicolon", () => {
  const sql = "SELECT 1; SELECT 2";
  assert.equal(findStatementAtCursor(sql, 3), "SELECT 1");
});

test("finds second statement after semicolon", () => {
  const sql = "SELECT 1; SELECT 2";
  assert.equal(findStatementAtCursor(sql, 12), "SELECT 2");
});

test("cursor at semicolon belongs to first statement", () => {
  const sql = "SELECT 1; SELECT 2";
  assert.equal(findStatementAtCursor(sql, 9), "SELECT 1");
});

test("cursor at end belongs to last statement", () => {
  const sql = "SELECT 1; SELECT 2";
  assert.equal(findStatementAtCursor(sql, 18), "SELECT 2");
});

test("skips semicolons inside single-quoted strings", () => {
  const sql = "SELECT ';'; SELECT 2";
  assert.equal(findStatementAtCursor(sql, 15), "SELECT 2");
  assert.equal(findStatementAtCursor(sql, 3), "SELECT ';'");
});

test("skips semicolons inside double-quoted identifiers", () => {
  const sql = 'SELECT ";"; SELECT 2';
  assert.equal(findStatementAtCursor(sql, 3), 'SELECT ";"');
});

test("skips semicolons inside line comments", () => {
  const sql = "SELECT 1 -- ; comment\n; SELECT 2";
  assert.equal(findStatementAtCursor(sql, 3), "SELECT 1 -- ; comment");
  assert.equal(findStatementAtCursor(sql, 25), "SELECT 2");
});

test("skips semicolons inside block comments", () => {
  const sql = "SELECT 1 /* ; */ ; SELECT 2";
  assert.equal(findStatementAtCursor(sql, 3), "SELECT 1 /* ; */");
  assert.equal(findStatementAtCursor(sql, 22), "SELECT 2");
});

test("handles multiple statements", () => {
  const sql = "INSERT INTO t VALUES (1); UPDATE t SET x = 2; DELETE FROM t";
  assert.equal(findStatementAtCursor(sql, 5), "INSERT INTO t VALUES (1)");
  assert.equal(findStatementAtCursor(sql, 30), "UPDATE t SET x = 2");
  assert.equal(findStatementAtCursor(sql, 50), "DELETE FROM t");
});

test("handles trailing semicolon", () => {
  const sql = "SELECT 1;";
  assert.equal(findStatementAtCursor(sql, 3), "SELECT 1");
});

test("handles backtick-quoted identifiers", () => {
  const sql = "SELECT `a;b`; SELECT 2";
  assert.equal(findStatementAtCursor(sql, 3), "SELECT `a;b`");
});
