import assert from "node:assert/strict";
import { test } from "vitest";
import { buildRedisSyntaxDiagnostics, shouldRunRedisDiagnostics, tokenizeRedisLine } from "../../apps/desktop/src/lib/redis/redisSyntaxDiagnostics.ts";

function messages(source: string): string[] {
  return buildRedisSyntaxDiagnostics(source).map((d) => d.message);
}

test("reports no diagnostics for read-only valid commands", () => {
  assert.deepEqual(messages("GET foo"), []);
  assert.deepEqual(messages("HGETALL k"), []);
  assert.deepEqual(messages("SCAN 0"), []);
  assert.deepEqual(messages("ZRANDMEMBER leaderboard 2 WITHSCORES"), []);
});

test("recognizes set store commands as writes", () => {
  const diags = buildRedisSyntaxDiagnostics("SDIFFSTORE destination source-a source-b");
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, "warning");
  assert.doesNotMatch(diags[0].message, /Unknown command/);
});

test("flags unknown command name", () => {
  const diags = buildRedisSyntaxDiagnostics("GETT foo");
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, "error");
  assert.match(diags[0].message, /Unknown command 'GETT'/);
  // span covers the command-name token on line 1
  assert.equal(diags[0].span.start_line, 1);
  assert.equal(diags[0].span.start_column, 1);
});

test("flags wrong arity (too few arguments)", () => {
  const diags = buildRedisSyntaxDiagnostics("GET");
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /Wrong number of arguments for 'GET'/);
  assert.match(diags[0].message, /expected exactly 1 argument/);
});

test("flags wrong arity (too many arguments)", () => {
  // GET arity is 2 (exact). Extra args → error.
  const diags = buildRedisSyntaxDiagnostics("GET a b");
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /Wrong number of arguments for 'GET'/);
});

test("respects variable arity (negative arity is a minimum)", () => {
  // MSET arity -3 → at least 2 args; 2 args (3 tokens) is valid.
  const ok3 = buildRedisSyntaxDiagnostics("MSET k1 v1");
  assert.equal(ok3.length, 0);
  const ok4 = buildRedisSyntaxDiagnostics("MSET k1 v1 k2 v2");
  assert.equal(ok4.length, 0);
  // Too few → arity error takes precedence.
  const diags = buildRedisSyntaxDiagnostics("MSET k1");
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /Wrong number of arguments for 'MSET'/);
});

test("flags unclosed quote and spans to end of line", () => {
  const diags = buildRedisSyntaxDiagnostics('SET "abc b');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, "error");
  assert.match(diags[0].message, /Unclosed quote/);
  assert.equal(diags[0].span.start_column, 5); // quote starts at column 5
});

test("highlights destructive commands as warning", () => {
  const diags = buildRedisSyntaxDiagnostics("DEL x");
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, "warning");
  assert.match(diags[0].message, /Dangerous command 'DEL'/);
});

test("highlights flushall as blocked error but flushdb as confirm warning", () => {
  // Aligned with the execution safety classification: FLUSHALL=blocked, FLUSHDB=confirm.
  const all = buildRedisSyntaxDiagnostics("FLUSHALL");
  assert.equal(all.length, 1);
  assert.equal(all[0].severity, "error");
  assert.match(all[0].message, /Blocked command 'FLUSHALL'/);

  const db = buildRedisSyntaxDiagnostics("FLUSHDB");
  assert.equal(db.length, 1);
  assert.equal(db[0].severity, "warning");
  assert.match(db[0].message, /Dangerous command 'FLUSHDB'/);
});

test("subcommands resolve via MAIN SUB key", () => {
  // XGROUP CREATE stream group id MKSTREAM → 6 tokens, satisfies arity -6.
  const diags = buildRedisSyntaxDiagnostics("XGROUP CREATE stream group $ MKSTREAM");
  assert.equal(diags.length, 0);
});

test("treats command names case-insensitively", () => {
  assert.deepEqual(messages("get foo"), []);
  const setDiag = buildRedisSyntaxDiagnostics("Set a b");
  assert.equal(setDiag.length, 0);
  const diags = buildRedisSyntaxDiagnostics("flushall");
  assert.match(diags[0].message, /Blocked command 'flushall'/);
});

test("handles multi-line input with per-line diagnostics", () => {
  const source = "GET ok\nFLUSHALL\nBADCMD x";
  const diags = buildRedisSyntaxDiagnostics(source);
  assert.equal(diags.length, 2);
  const lines = diags.map((d) => d.span.start_line).sort((a, b) => a - b);
  assert.deepEqual(lines, [2, 3]);
  assert.match(diags.find((d) => d.span.start_line === 2)!.message, /Blocked/);
  assert.match(diags.find((d) => d.span.start_line === 3)!.message, /Unknown command/);
});

test("ignores blank and comment lines", () => {
  assert.deepEqual(messages(""), []);
  assert.deepEqual(messages("\n\n"), []);
  assert.deepEqual(messages("# a note\nGET foo"), []);
  assert.deepEqual(messages("-- note\nGET foo"), []);
});

test("strips trailing semicolon terminator", () => {
  assert.deepEqual(messages("GET foo;"), []);
});

test("shouldRunRedisDiagnostics waits while typing the command name", () => {
  // cursor at end of a bare partial token (no whitespace yet) → wait
  assert.equal(shouldRunRedisDiagnostics("GETT", 4), false);
  // once a space exists after the command name → run
  assert.equal(shouldRunRedisDiagnostics("GETT foo", 8), true);
  assert.equal(shouldRunRedisDiagnostics("", 0), false);
});

test("tokenizeRedisLine preserves quoted values with spaces", () => {
  const { argv, unclosedQuote } = tokenizeRedisLine('SET mykey "hello world"');
  assert.equal(unclosedQuote, false);
  assert.deepEqual(
    argv.map((t) => t.value),
    ["SET", "mykey", "hello world"],
  );
  assert.equal(argv[2]!.startColumn, 11);
});

test("tokenizeRedisLine handles backslash escapes", () => {
  const { argv } = tokenizeRedisLine("SET k a\\ b");
  assert.deepEqual(
    argv.map((t) => t.value),
    ["SET", "k", "a b"],
  );
});
