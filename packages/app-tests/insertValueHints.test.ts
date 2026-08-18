import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildInsertValueHints, expandToSqlStatementWindow, parseInsertValueHints, parseInsertValueHintsInRanges, parseInsertValuesClauses } from "../../apps/desktop/src/lib/sql/insertValueHints.ts";
import { insertValueHintColumnNames } from "../../apps/desktop/src/lib/sql/insertValueHintColumns.ts";

/**
 * These perf tests care about *algorithmic* behavior (did we reintroduce O(document) scanning),
 * not absolute machine speed, which varies too much across CI runners to pin with a fixed ms
 * budget (a maintainer flagged a hard-coded `< 50ms` assertion here as CI-flaky for exactly this
 * reason). Measuring at two scales and asserting the ratio stays bounded cancels out machine
 * speed; the absolute `maxMs` floor stays only as a generous backstop against an actual hang.
 */
function assertSublinearScaling(measureAt: (scale: number) => number, options: { smallScale: number; bigScale: number; maxRatio: number; maxMs: number; label: string }): void {
  const { smallScale, bigScale, maxRatio, maxMs, label } = options;
  const smallMs = measureAt(smallScale);
  const bigMs = measureAt(bigScale);
  assert.ok(
    bigMs < Math.max(maxMs, smallMs * maxRatio),
    `${label}: ${smallScale}x took ${smallMs.toFixed(1)}ms, ${bigScale}x took ${bigMs.toFixed(1)}ms -- expected roughly bounded, not scaling with document size`,
  );
}

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

test("does not split PostgreSQL dollar-quoted values", () => {
  const sql = "INSERT INTO t (body, count) VALUES ($tag$hello,(world),again$tag$, 2)";
  const hints = parseInsertValueHints(sql);
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["body", "count"],
  );
  assert.ok(sql.slice(hints[0]!.from).startsWith("$tag$hello,(world),again$tag$"));
  assert.equal(sql.slice(hints[1]!.from, hints[1]!.from + 1), "2");
});

test("skips SQL Server table hints before the INSERT column list", () => {
  const sql = "INSERT INTO dbo.Users WITH (TABLOCK) (id, name) VALUES (1, 'alice')";
  const hints = parseInsertValueHints(sql);
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["id", "name"],
  );
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

test("skips SQL Server identity columns when mapping multi-row VALUES without a column list", () => {
  const sql = "INSERT INTO dbo.users VALUES (N'A', 1), (N'B', 2)";
  const columns = insertValueHintColumnNames("sqlserver", [
    { name: "id", is_identity: true },
    { name: "name" },
    { name: "status" },
  ]);
  const hints = parseInsertValueHints(sql, {
    resolveTableColumns: () => columns,
  });
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["name", "status", "name", "status"],
  );
});

test("skips SQL Server computed and temporal generated columns in positional hints", () => {
  const columns = insertValueHintColumnNames("sqlserver", [
    { name: "id", is_identity: true },
    { name: "quantity" },
    { name: "doubled", is_computed: true },
    { name: "note" },
    { name: "valid_from", is_hidden: true, generated_always_type: 1 },
    { name: "valid_to", is_hidden: true, generated_always_type: 2 },
  ]);

  assert.deepEqual(columns, ["quantity", "note"]);
});

test("skips visible SQL Server generated columns in positional hints", () => {
  assert.deepEqual(
    insertValueHintColumnNames("sqlserver", [
      { name: "name" },
      { name: "valid_from", generated_always_type: 1 },
      { name: "valid_to", generated_always_type: 2 },
    ]),
    ["name"],
  );
});

test("keeps identity columns in positional hints for databases other than SQL Server", () => {
  assert.deepEqual(
    insertValueHintColumnNames("postgres", [
      { name: "id", is_identity: true },
      { name: "name" },
    ]),
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
  assert.equal(clauses[0]?.database, undefined);
  assert.equal(clauses[0]?.columns, null);
});

test("preserves three-part database.schema.table qualifiers", () => {
  const clauses = parseInsertValuesClauses("INSERT INTO OtherDb.dbo.Users VALUES (1, 'a')");
  assert.equal(clauses.length, 1);
  assert.equal(clauses[0]?.database, "OtherDb");
  assert.equal(clauses[0]?.schema, "dbo");
  assert.equal(clauses[0]?.table, "Users");
});

test("preserves quoted three-part database.schema.table qualifiers", () => {
  const clauses = parseInsertValuesClauses('INSERT INTO "OtherDb"."dbo"."Users" VALUES (1)');
  assert.equal(clauses[0]?.database, "OtherDb");
  assert.equal(clauses[0]?.schema, "dbo");
  assert.equal(clauses[0]?.table, "Users");
});

test("routes three-part names through resolveTableColumns database argument", () => {
  const sql = "INSERT INTO OtherDb.dbo.Users VALUES (1, 'a')";
  const calls: Array<{ table: string; schema?: string; database?: string }> = [];
  const hints = parseInsertValueHints(sql, {
    resolveTableColumns: (table, schema, database) => {
      calls.push({ table, schema, database });
      if (database === "OtherDb" && schema === "dbo" && table === "Users") return ["id", "name"];
      return ["wrong_id"];
    },
  });
  assert.deepEqual(calls, [{ table: "Users", schema: "dbo", database: "OtherDb" }]);
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["id", "name"],
  );
});

test("parses only statement windows covering provided ranges", () => {
  const prefix = `${"SELECT 1;\n".repeat(200)}`;
  const insert = "INSERT INTO t (id, name) VALUES (1, 'x');";
  const suffix = `\n${"SELECT 2;\n".repeat(200)}`;
  const sql = `${prefix}${insert}${suffix}`;
  const insertFrom = prefix.length;
  const hints = parseInsertValueHintsInRanges(sql, [{ from: insertFrom, to: insertFrom + 10 }]);
  assert.deepEqual(
    hints.map((hint) => hint.column),
    ["id", "name"],
  );
  assert.equal(sql.slice(hints[0]!.from, hints[0]!.from + 1), "1");
});

test("expandToSqlStatementWindow stops at neighboring statements", () => {
  const sql = "SELECT 1; INSERT INTO t (a) VALUES (1); SELECT 2;";
  const insertAt = sql.indexOf("INSERT");
  const window = expandToSqlStatementWindow(sql, insertAt, insertAt + 6);
  assert.equal(sql.slice(window.from, window.to), "INSERT INTO t (a) VALUES (1)");
});

test("expandToSqlStatementWindow proves clean state when the cursor is more than 32KiB into an unterminated single-quoted string", () => {
  const body = "x".repeat(60_000);
  const sql = `SELECT '${body}', 'end';`;
  const cursor = sql.indexOf(body) + 40_000;
  const window = expandToSqlStatementWindow(sql, cursor, cursor);
  assert.equal(window.from, 0, "the backward scan must not land mid-string and mistake it for a statement boundary");
});

test("expandToSqlStatementWindow proves clean state when the cursor is more than 32KiB into an unterminated block comment", () => {
  const body = "chatter ".repeat(8_000);
  const sql = `SELECT /* ${body} */ 1;`;
  const cursor = sql.indexOf(body) + 40_000;
  const window = expandToSqlStatementWindow(sql, cursor, cursor);
  assert.equal(window.from, 0, "the backward scan must not land mid-comment and mistake it for a statement boundary");
});

test("expandToSqlStatementWindow proves clean state when the cursor is more than 32KiB into a dollar-quoted body full of semicolons", () => {
  const body = "SELECT 1; SELECT 2; ".repeat(3_000);
  const sql = `CREATE FUNCTION f() RETURNS void AS $$ ${body} $$ LANGUAGE sql;`;
  const cursor = sql.indexOf(body) + 40_000;
  const window = expandToSqlStatementWindow(sql, cursor, cursor);
  assert.equal(
    window.from,
    0,
    "semicolons inside a dollar-quoted function body are not statement boundaries, even past the lookback window",
  );
});

test("expandToSqlStatementWindow proves clean state when the cursor is more than 32KiB into deeply nested parens", () => {
  const opens = "(".repeat(2_000);
  const junk = `${"z".repeat(40_000)};${"z".repeat(2_000)}`;
  const closes = ")".repeat(2_000);
  const sql = `SELECT ${opens}${junk}${closes};`;
  const cursor = sql.indexOf(junk) + junk.length - 100;
  const window = expandToSqlStatementWindow(sql, cursor, cursor);
  assert.equal(
    window.from,
    0,
    "a ';' more than 32KiB past unclosed '(' characters is still nested, not a top-level statement boundary",
  );
});

test("expandToSqlStatementWindow stays bounded (fast path) for many small statements even far into the document", () => {
  // Each call below builds a fresh document (a different string instance each time even where
  // content happens to repeat) and uses a distinct cursor per scale, so none of these hit
  // expandToSqlStatementWindow's single-entry (sql, from, to, dialectId) memo -- a cache hit
  // would make the "big scale" timing artificially near-zero and defeat the point of this test.
  let bigScaleFromIsNonZero = false;
  assertSublinearScaling(
    (count) => {
      const sql = Array.from({ length: count }, (_, index) => `SELECT ${index};`).join("\n");
      const cursor = sql.length - 10;
      const startedAt = performance.now();
      const window = expandToSqlStatementWindow(sql, cursor, cursor);
      const elapsedMs = performance.now() - startedAt;
      if (count === 20_000) bigScaleFromIsNonZero = window.from !== 0;
      return elapsedMs;
    },
    { smallScale: 2_000, bigScale: 20_000, maxRatio: 5, maxMs: 200, label: "expandToSqlStatementWindow (many small statements)" },
  );
  assert.ok(bigScaleFromIsNonZero, "should resolve via the bounded backward scan, not fall back to a full-document scan");
});

test("expandToSqlStatementWindow treats '#' as a dialect-sensitive operator/comment, matching tokenizeSqlSemantic", () => {
  const sql = "SELECT 5 # 3; SELECT 1;";
  const cursor = sql.indexOf("SELECT 1") + 4;
  // PostgreSQL: '#' is an operator (e.g. #, #>, #>>, #-), so this is two statements and the
  // window around the cursor must not include the unrelated first one.
  const postgresWindow = expandToSqlStatementWindow(sql, cursor, cursor, "postgres");
  assert.equal(sql.slice(postgresWindow.from, postgresWindow.to), "SELECT 1");
  // MySQL (and the default, unspecified dialect): '#' starts a line comment that never closes
  // (no trailing newline), so the ';' after it is inside the comment, not a real boundary -- the
  // whole input is one statement, matching tokenizeSqlSemantic's own MySQL tokenization.
  const mysqlWindow = expandToSqlStatementWindow(sql, cursor, cursor, "mysql");
  assert.equal(mysqlWindow.from, 0);
  const defaultWindow = expandToSqlStatementWindow(sql, cursor, cursor);
  assert.equal(defaultWindow.from, 0, "omitting dialectId must keep the prior default (mysql-like) behavior");
});

test("expandToSqlStatementWindow does not reallocate per '$' for many dollar-quote-marker lookalikes", () => {
  assertSublinearScaling(
    (count) => {
      const placeholders = Array.from({ length: count }, (_, index) => `$${index}`).join(", ");
      const sql = `SELECT ${placeholders};`;
      const cursor = sql.length - 5;
      const startedAt = performance.now();
      expandToSqlStatementWindow(sql, cursor, cursor);
      return performance.now() - startedAt;
    },
    { smallScale: 2_000, bigScale: 20_000, maxRatio: 5, maxMs: 200, label: "expandToSqlStatementWindow (many '$' markers)" },
  );
});

test("expandToSqlStatementWindow reuses the cached result for identical (sql, from, to, dialectId) calls", () => {
  const sql = "SELECT 5 # 3; SELECT 1;";
  const cursor = sql.indexOf("SELECT 1") + 4;
  const first = expandToSqlStatementWindow(sql, cursor, cursor, "postgres");
  const second = expandToSqlStatementWindow(sql, cursor, cursor, "postgres");
  assert.equal(first, second, "identical args should return the memoized object, not a freshly computed one");
  const third = expandToSqlStatementWindow(sql, cursor, cursor);
  assert.notEqual(third, first, "a different dialectId must not reuse another dialect's cached window");
});

test("expandToSqlStatementWindow does not treat a backslash-escaped quote as closing the string", () => {
  const sql = "SELECT 'it\\'s a test; end' FROM t;";
  const cursor = sql.indexOf("FROM") + 2;
  const window = expandToSqlStatementWindow(sql, cursor, cursor);
  assert.equal(
    sql.slice(window.from, window.to),
    "SELECT 'it\\'s a test; end' FROM t",
    "the ';' inside the backslash-escaped string must not be mistaken for the statement boundary",
  );
});

test("expandToSqlStatementWindow terminates a line comment at a bare '\\r' (no trailing '\\n')", () => {
  const sql = "SELECT 1; -- comment\rSELECT 2;";
  const cursor = sql.indexOf("SELECT 2") + 4;
  const window = expandToSqlStatementWindow(sql, cursor, cursor);
  assert.equal(
    sql.slice(window.from, window.to),
    "-- comment\rSELECT 2",
    "the comment must end at '\\r' so the trailing ';' is recognized as the real statement boundary",
  );
});

test("expandToSqlStatementWindow finds the real end of a single statement larger than one lookahead window, instead of truncating", () => {
  const bigString = "x".repeat(100_000);
  const sql = `INSERT INTO t (a) VALUES ('${bigString}');`;
  const cursor = sql.indexOf(bigString) + 10;
  const window = expandToSqlStatementWindow(sql, cursor, cursor);
  assert.equal(window.to, sql.length - 1, "must resume scanning past the first lookahead miss instead of stopping at an arbitrary hardStop");
});

test("parseInsertValuesClauses honors a dialectId so postgres '#' does not hide a following INSERT", () => {
  const sql = "SELECT 5 # 3; INSERT INTO t (a) VALUES (1);";
  assert.deepEqual(
    parseInsertValuesClauses(sql, "postgres").map((clause) => clause.table),
    ["t"],
  );
  assert.deepEqual(
    parseInsertValuesClauses(sql).map((clause) => clause.table),
    [],
    "default (mysql) dialect treats '#' as an unterminated comment, swallowing the INSERT -- unchanged prior behavior",
  );
});

test("documents a known limitation of the pure-string fallback (no live EditorState): a huge run of lexically-inert statements inside an unclosed dollar-quoted body can fool resolveStatementStart's widen-and-agree check", () => {
  // See the "IMPORTANT" note on expandToSqlStatementWindow's doc comment: verifying a backward
  // scan's starting state by widening until two scans agree is a heuristic, not a proof. It is
  // fooled when the content between the two scan-start points is lexically inert (no quotes,
  // parens, comments, or dollar-quote markers) -- both scans converge on the same wrong answer
  // regardless of the true (hidden) state.
  //
  // This test pins the current, known-imperfect behavior of the pure-string fallback path only
  // (expandToSqlStatementWindow, used when no live EditorState is available -- e.g. this test
  // file, or codemirrorInsertValueHints.ts's cosmetic inlay hints) so it's visible and intentional
  // rather than a silent regression. It is NOT the behavior a real user typing in the editor sees:
  // sqlCompletion.ts's `getSqlLexicalContext`/`activeSqlCompletionStatementSpan` prefer
  // `sqlSyntaxTreeWindow.ts`'s syntax-tree-backed resolution whenever a live EditorState is
  // available, which is provably correct for this exact class of input (unterminated strings,
  // comments) -- see apps/desktop/src/lib/__tests__/sql/sqlSyntaxTreeWindow.spec.ts and
  // sqlCompletion.syntaxTree.spec.ts, which assert the *correct* answer for the sibling
  // counterexample the pure-string scanner gets wrong here. Dollar-quoted bodies specifically
  // remain an open, disclosed gap even on the tree path (see sqlSyntaxTreeWindow.ts's doc comment
  // on why: this app disables doubleDollarQuotedStrings for PL/pgSQL highlighting, issue #788).
  const body = Array.from({ length: 60_000 }, (_, index) => `SELECT ${index};`).join(" ");
  const sql = `CREATE FUNCTION f() RETURNS void AS $$ ${body} $$ LANGUAGE sql;`;
  const cursor = sql.indexOf(body) + 500_000;
  const window = expandToSqlStatementWindow(sql, cursor, cursor);
  assert.notEqual(window.from, 0, "known-imperfect (pure-string fallback only): a correct implementation would return 0 here (the whole CREATE FUNCTION is one statement)");
});

test("ignores statements that are not INSERT VALUES", () => {
  const sql = "SELECT 1; UPDATE users SET name = 'a' WHERE id = 1;";
  assert.deepEqual(parseInsertValueHints(sql), []);
});

test("scans large procedural sources without repeatedly filtering all tokens", () => {
  let bigScaleHints: unknown[] = [];
  assertSublinearScaling(
    (count) => {
      const sql = Array.from({ length: count }, (_, index) => `v_value := v_value + ${index % 10};`).join("\n");
      const startedAt = performance.now();
      const hints = parseInsertValueHints(sql);
      const elapsedMs = performance.now() - startedAt;
      if (count === 6_000) bigScaleHints = hints;
      return elapsedMs;
    },
    { smallScale: 600, bigScale: 6_000, maxRatio: 5, maxMs: 2000, label: "parseInsertValueHints (large procedural source)" },
  );
  assert.deepEqual(bigScaleHints, []);
});

test("buildInsertValueHints skips unresolved tables without metadata", () => {
  const clauses = parseInsertValuesClauses("INSERT INTO mystery VALUES (1, 2)");
  assert.deepEqual(buildInsertValueHints(clauses), []);
});
