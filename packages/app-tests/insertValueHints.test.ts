import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildInsertValueHints, parseInsertValueHints, parseInsertValuesClauses } from "../../apps/desktop/src/lib/sql/insertValueHints.ts";

test("maps explicit column list to single-row VALUES", () => {
  const sql = "INSERT INTO auth_user (id, password, last_login) VALUES (5, 'hash', NULL)";
  const hints = parseInsertValueHints(sql);
  assert.deepEqual(
    hints.map((hint) => ({ column: hint.column, text: sql.slice(hint.from, hint.from + 1) })),
    [
      { column: "id", text: "5" },
      { column: "password", text: "'" },
      { column: "last_login", text: "N" },
    ],
  );
});

test("supports multi-row VALUES", () => {
  const sql = "INSERT INTO users (id, name) VALUES (1, 'a'), (2, 'b')";
  const hints = parseInsertValueHints(sql);
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["id", "name", "id", "name"],
  );
  assert.equal(sql.slice(hints[0]!.from, hints[0]!.from + 1), "1");
  assert.equal(sql.slice(hints[2]!.from, hints[2]!.from + 1), "2");
});

test("does not split nested parentheses inside a value", () => {
  const sql = "INSERT INTO t (a, b) VALUES (COALESCE(x, y), NOW())";
  const hints = parseInsertValueHints(sql);
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["a", "b"],
  );
  assert.ok(sql.slice(hints[0]!.from).startsWith("COALESCE(x, y)"));
  assert.ok(sql.slice(hints[1]!.from).startsWith("NOW()"));
});

test("resolves columns from table metadata when column list is omitted", () => {
  const sql = "INSERT INTO users VALUES (1, 'alice')";
  const hints = parseInsertValueHints(sql, {
    resolveTableColumns: (table) => (table === "users" ? ["id", "name"] : undefined),
  });
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["id", "name"],
  );
});

test("returns no hints for INSERT ... SELECT", () => {
  const sql = "INSERT INTO users (id, name) SELECT id, name FROM staging";
  assert.deepEqual(parseInsertValueHints(sql), []);
  assert.deepEqual(parseInsertValuesClauses(sql), []);
});

test("caps hints when value count exceeds column count", () => {
  const sql = "INSERT INTO t (a, b) VALUES (1, 2, 3)";
  const hints = parseInsertValueHints(sql);
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["a", "b"],
  );
});

test("caps hints when column count exceeds value count", () => {
  const sql = "INSERT INTO t (a, b, c) VALUES (1, 2)";
  const hints = parseInsertValueHints(sql);
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["a", "b"],
  );
});

test("handles quoted identifiers in column list", () => {
  const sql = 'INSERT INTO "User" ("Id", "Name") VALUES (1, \'x\')';
  const hints = parseInsertValueHints(sql);
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["Id", "Name"],
  );
});

test("parses schema-qualified table without column list", () => {
  const clauses = parseInsertValuesClauses("INSERT INTO dbo.Users VALUES (1)");
  assert.equal(clauses.length, 1);
  assert.equal(clauses[0]?.table, "Users");
  assert.equal(clauses[0]?.schema, "dbo");
  assert.equal(clauses[0]?.columns, null);
});

test("ignores statements that are not INSERT VALUES", () => {
  const sql = "SELECT 1; UPDATE users SET name = 'a' WHERE id = 1;";
  assert.deepEqual(parseInsertValueHints(sql), []);
});

test("buildInsertValueHints skips unresolved tables without metadata", () => {
  const clauses = parseInsertValuesClauses("INSERT INTO mystery VALUES (1, 2)");
  assert.deepEqual(buildInsertValueHints(clauses), []);
});
