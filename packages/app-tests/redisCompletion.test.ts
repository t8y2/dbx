import assert from "node:assert/strict";
import { test } from "vitest";
import { buildRedisCompletionItems, getRedisCompletionContext, getRedisCompletionResultValidFor, shouldAutoOpenRedisCompletion, takesKeyArgument } from "../../apps/desktop/src/lib/redis/redisCompletion.ts";

function labels(items: { label: string }[]): string[] {
  return items.map((item) => item.label);
}

test("command mode: completes command names by prefix (case-insensitive)", () => {
  const items = buildRedisCompletionItems("GE", 2);
  const names = labels(items);
  assert.ok(names.includes("GET"));
  assert.ok(names.includes("GETSET"));
  assert.ok(names.includes("GETRANGE"));
  // no subcommand forms leak in
  assert.ok(!names.some((n) => n.includes(" ")));
  // lowercase prefix also works
  assert.ok(labels(buildRedisCompletionItems("ge", 2)).includes("GET"));
});

test("command mode: does not surface bare subcommand labels", () => {
  const items = buildRedisCompletionItems("XGROUP", 6);
  const names = labels(items);
  assert.ok(names.includes("XGROUP"));
  // "CREATE" alone is not a top-level command
  assert.ok(!names.includes("CREATE"));
});

test("command mode: detail/info carry group + arity + safety", () => {
  const items = buildRedisCompletionItems("FLUSHALL", 9);
  const flush = items.find((item) => item.label === "FLUSHALL");
  assert.ok(flush);
  assert.match(flush!.detail ?? "", /server.*blocked/i);
  assert.match(flush!.info ?? "", /Group:\s*server/i);
  assert.match(flush!.info ?? "", /Arity:/i);
  assert.match(flush!.info ?? "", /Safety:\s*blocked/i);
});

test("subcommand mode: after 'XGROUP ' suggests its subcommands", () => {
  const items = buildRedisCompletionItems("XGROUP ", 7);
  const names = labels(items);
  assert.ok(names.includes("CREATE"));
  assert.ok(names.includes("DESTROY"));
  assert.ok(names.includes("SETID"));
  // unrelated commands absent
  assert.ok(!names.includes("GET"));
});

test("subcommand mode: filters subcommands by prefix", () => {
  const items = buildRedisCompletionItems("XGROUP C", 8);
  const names = labels(items);
  assert.ok(names.includes("CREATE"));
  assert.ok(names.includes("CREATECONSUMER"));
  assert.ok(!names.includes("DESTROY"));
});

test("OBJECT completion uses Redis space-delimited subcommands", () => {
  const commandNames = labels(buildRedisCompletionItems("OBJECT", 6));
  assert.ok(commandNames.includes("OBJECT"));
  assert.ok(!commandNames.some((name) => name.startsWith("OBJECT_")));

  const subcommands = labels(buildRedisCompletionItems("OBJECT ", 7));
  assert.deepEqual(new Set(subcommands), new Set(["ENCODING", "FREQ", "IDLETIME", "REFCOUNT", "HELP"]));
  assert.ok(!subcommands.some((name) => name.includes("_")));
});

test("argument mode: offers key names for key-taking commands", () => {
  const items = buildRedisCompletionItems("GET ", 4, { keys: ["user:1", "user:2", "config:db"] });
  const names = labels(items);
  assert.ok(names.includes("user:1"));
  assert.ok(names.includes("user:2"));
});

test("argument mode: filters keys by substring prefix", () => {
  const items = buildRedisCompletionItems("GET user", 8, { keys: ["user:1", "user:2", "config:db"] });
  const names = labels(items);
  assert.ok(names.includes("user:1"));
  assert.ok(names.includes("user:2"));
  assert.ok(!names.includes("config:db"));
});

test("argument mode: empty keys yields no key items", () => {
  const items = buildRedisCompletionItems("GET ", 4, { keys: [] });
  assert.equal(items.length, 0);
});

test("argument mode: does not suggest keys once the key argument is filled in", () => {
  // GET takes exactly one key argument; after "GET key " the next slot is out of range.
  assert.equal(buildRedisCompletionItems("GET key ", 8, { keys: ["user:1"] }).length, 0);
  assert.equal(buildRedisCompletionItems("GET key extra ", 14, { keys: ["user:1"] }).length, 0);
  // HSET takes key then field/value; after the key only non-key args remain.
  assert.equal(buildRedisCompletionItems("HSET k ", 7, { keys: ["user:1"] }).length, 0);
});

test("argument mode: variadic key-list commands keep suggesting keys", () => {
  // DEL accepts multiple keys — keep suggesting after the first one.
  assert.ok(labels(buildRedisCompletionItems("DEL k1 ", 7, { keys: ["user:1"] })).includes("user:1"));
  assert.ok(labels(buildRedisCompletionItems("EXISTS k1 k2 ", 13, { keys: ["user:1"] })).includes("user:1"));
});

test("argument mode: still suggests keys at the first argument slot", () => {
  // GET <here> — first argument position
  const items = buildRedisCompletionItems("GET ", 4, { keys: ["user:1", "user:2"] });
  assert.ok(labels(items).includes("user:1"));
});

test("argument mode: non-key commands (FLUSHDB) do not suggest keys", () => {
  const items = buildRedisCompletionItems("FLUSHDB ", 8, { keys: ["user:1", "user:2"] });
  assert.equal(items.length, 0);
});

test("takesKeyArgument reflects command group", () => {
  assert.equal(takesKeyArgument("GET"), true); // string
  assert.equal(takesKeyArgument("HSET"), true); // hash
  assert.equal(takesKeyArgument("DEL"), true); // generic
  assert.equal(takesKeyArgument("FLUSHDB"), false); // server
  assert.equal(takesKeyArgument("SELECT"), false); // connection
  assert.equal(takesKeyArgument(undefined), false);
});

test("context parsing: empty line → command mode", () => {
  const ctx = getRedisCompletionContext("", 0);
  assert.equal(ctx.mode, "command");
  assert.equal(ctx.prefix, "");
});

test("context parsing: command + space → subcommand mode when the command has subcommands", () => {
  const ctx = getRedisCompletionContext("XGROUP ", 7);
  assert.equal(ctx.mode, "subcommand");
  assert.equal(ctx.mainCommand, "XGROUP");
});

test("context parsing: GET + space → argument mode", () => {
  const ctx = getRedisCompletionContext("GET ", 4);
  assert.equal(ctx.mode, "argument");
  assert.equal(ctx.mainCommand, "GET");
});

test("shouldAutoOpenRedisCompletion opens on word/space chars, not newline", () => {
  assert.equal(shouldAutoOpenRedisCompletion("GET", 3), true);
  assert.equal(shouldAutoOpenRedisCompletion("GET ", 4), true); // space → offer keys/subcommands
  assert.equal(shouldAutoOpenRedisCompletion("GET\n", 4), false);
  assert.equal(shouldAutoOpenRedisCompletion("user:", 5), true);
});

test("result validFor covers command-name and key-name characters", () => {
  const re = getRedisCompletionResultValidFor();
  assert.equal(re.test("GET"), true);
  assert.equal(re.test("user:1"), true);
  assert.equal(re.test("a.b-c"), true);
});
