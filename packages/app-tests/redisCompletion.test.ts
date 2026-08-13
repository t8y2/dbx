import assert from "node:assert/strict";
import { test } from "vitest";
import { buildRedisCompletionItems, getRedisCompletionContext, getRedisCompletionResultValidFor, shouldAutoOpenRedisCompletion, takesKeyArgument, type RedisCompletionInput } from "../../apps/desktop/src/lib/redis/redisCompletion.ts";
import type { RedisCommandArgument, RedisCommandDocumentation, RedisCommandKeySpec } from "../../apps/desktop/src/lib/redis/redisCommandDocs.ts";
import { tokenizeRedisLine } from "../../apps/desktop/src/lib/redis/redisCommandTokenizer.ts";

const oneKey: RedisCommandKeySpec[] = [{ beginSearch: { type: "index", index: 1 }, findKeys: { type: "range", lastKey: 0, keyStep: 1, limit: 0 } }];
const allRemainingKeys: RedisCommandKeySpec[] = [{ beginSearch: { type: "index", index: 1 }, findKeys: { type: "range", lastKey: -1, keyStep: 1, limit: 0 } }];
const xreadArguments: RedisCommandArgument[] = [
  { name: "count", token: "COUNT", type: "integer", optional: true },
  { name: "maxcount", token: "MAXCOUNT", type: "integer", optional: true },
  { name: "maxsize", token: "MAXSIZE", type: "integer", optional: true },
  { name: "milliseconds", token: "BLOCK", type: "integer", optional: true },
  {
    name: "streams",
    token: "STREAMS",
    type: "block",
    arguments: [
      { name: "key", type: "key", multiple: true },
      { name: "ID", type: "string", multiple: true },
    ],
  },
];

const commands: RedisCommandDocumentation[] = [
  { name: "ACL", group: "server", arity: -2, summary: "Access control commands.", keySpecs: [] },
  { name: "ACL CAT", group: "server", arity: -2, summary: "Lists ACL categories.", keySpecs: [] },
  {
    name: "BITOP",
    group: "bitmap",
    arity: -4,
    keySpecs: [
      { beginSearch: { type: "index", index: 2 }, findKeys: { type: "range", lastKey: 0, keyStep: 1, limit: 0 } },
      { beginSearch: { type: "index", index: 3 }, findKeys: { type: "range", lastKey: -1, keyStep: 1, limit: 0 } },
    ],
  },
  { name: "BLPOP", group: "list", arity: -3, keySpecs: [{ beginSearch: { type: "index", index: 1 }, findKeys: { type: "range", lastKey: -2, keyStep: 1, limit: 0 } }] },
  { name: "DEL", group: "generic", arity: -2, keySpecs: allRemainingKeys },
  { name: "EVAL", group: "scripting", arity: -3, keySpecs: [{ beginSearch: { type: "index", index: 2 }, findKeys: { type: "keynum", keyNumIndex: 0, firstKey: 1, keyStep: 1 } }] },
  { name: "EXISTS", group: "generic", arity: -2, keySpecs: allRemainingKeys },
  { name: "FLUSHDB", group: "server", arity: -1, keySpecs: [] },
  { name: "GET", group: "string", arity: 2, keySpecs: oneKey },
  { name: "GETRANGE", group: "string", arity: 4, keySpecs: oneKey },
  { name: "GETSET", group: "string", arity: 3, keySpecs: oneKey },
  { name: "HSET", group: "hash", arity: -4, keySpecs: oneKey },
  {
    name: "MIGRATE",
    group: "generic",
    arity: -6,
    keySpecs: [
      { beginSearch: { type: "index", index: 3 }, findKeys: { type: "range", lastKey: 0, keyStep: 1, limit: 0 } },
      { beginSearch: { type: "keyword", keyword: "KEYS", startFrom: -2 }, findKeys: { type: "range", lastKey: -1, keyStep: 1, limit: 0 } },
    ],
  },
  { name: "OBJECT", group: "generic", arity: -2, keySpecs: [] },
  { name: "OBJECT ENCODING", group: "generic", arity: 3, keySpecs: oneKey },
  { name: "OBJECT FREQ", group: "generic", arity: 3, keySpecs: oneKey },
  { name: "OBJECT HELP", group: "generic", arity: 2, keySpecs: [] },
  { name: "OBJECT IDLETIME", group: "generic", arity: 3, keySpecs: oneKey },
  { name: "OBJECT REFCOUNT", group: "generic", arity: 3, keySpecs: oneKey },
  { name: "SELECT", group: "connection", arity: 2, keySpecs: [] },
  { name: "XGROUP", group: "stream", arity: -2, keySpecs: [] },
  { name: "XGROUP CREATE", group: "stream", arity: -5, keySpecs: oneKey },
  { name: "XGROUP DESTROY", group: "stream", arity: 4, keySpecs: oneKey },
  { name: "XGROUP SETID", group: "stream", arity: -4, keySpecs: oneKey },
  { name: "XREAD", group: "stream", arity: -4, arguments: xreadArguments, keySpecs: [{ beginSearch: { type: "keyword", keyword: "STREAMS", startFrom: 1 }, findKeys: { type: "range", lastKey: -1, keyStep: 1, limit: 2 } }] },
  {
    name: "XREADGROUP",
    group: "stream",
    arity: -7,
    arguments: [
      {
        name: "group-block",
        token: "GROUP",
        type: "block",
        arguments: [
          { name: "group", type: "string" },
          { name: "consumer", type: "string" },
        ],
      },
      { name: "count", token: "COUNT", type: "integer", optional: true },
      { name: "milliseconds", token: "BLOCK", type: "integer", optional: true },
      { name: "noack", token: "NOACK", type: "pure-token", optional: true },
      xreadArguments[4]!,
    ],
    keySpecs: [{ beginSearch: { type: "keyword", keyword: "STREAMS", startFrom: 4 }, findKeys: { type: "range", lastKey: -1, keyStep: 1, limit: 2 } }],
  },
];

function input(keys: string[] = []): RedisCompletionInput {
  return { commands, keys };
}

function complete(text: string, cursor = text.length, keys: string[] = []) {
  return buildRedisCompletionItems(text, cursor, input(keys));
}

function labels(items: { label: string }[]): string[] {
  return items.map((item) => item.label);
}

test("command candidates come only from the connected Redis instance", () => {
  const names = labels(complete("GE"));
  assert.deepEqual(names, ["GET", "GETRANGE", "GETSET"]);
  assert.ok(!names.includes("SET"));
  assert.deepEqual(buildRedisCompletionItems("GE", 2, { commands: [] }), []);
});

test("command mode completes documented names case-insensitively", () => {
  assert.ok(labels(complete("ge")).includes("GET"));
  assert.ok(!labels(complete("GET")).some((name) => name.includes(" ")));
});

test("subcommand mode follows the server's command hierarchy", () => {
  const names = labels(complete("XGROUP "));
  assert.deepEqual(new Set(names), new Set(["CREATE", "DESTROY", "SETID"]));
  assert.ok(!names.includes("GET"));
  assert.deepEqual(labels(complete("XGROUP C")), ["CREATE"]);

  const objectNames = labels(complete("OBJECT "));
  assert.deepEqual(new Set(objectNames), new Set(["ENCODING", "FREQ", "HELP", "IDLETIME", "REFCOUNT"]));
});

test("server metadata supplies module commands, summaries, and key completion", () => {
  const moduleCommands: RedisCommandDocumentation[] = [
    { name: "MODULE", group: "module", arity: -2, keySpecs: [] },
    { name: "MODULE SEARCH", group: "module", arity: -2, summary: "Searches module data.", keySpecs: oneKey },
  ];
  const moduleInput = { commands: moduleCommands, keys: ["session:1"] };
  assert.ok(labels(buildRedisCompletionItems("MO", 2, moduleInput)).includes("MODULE"));
  const search = buildRedisCompletionItems("MODULE S", 8, moduleInput).find((item) => item.label === "SEARCH");
  assert.equal(search?.summary, "Searches module data.");
  assert.ok(labels(buildRedisCompletionItems("MODULE SEARCH ", 14, moduleInput)).includes("session:1"));
});

test("argument keyword candidates follow the server's recursive command grammar", () => {
  assert.deepEqual(labels(complete("XREAD ")), ["COUNT", "MAXCOUNT", "MAXSIZE", "BLOCK", "STREAMS"]);
  assert.deepEqual(labels(complete("XREAD C")), ["COUNT"]);
  assert.deepEqual(complete("XREAD COUNT "), []);
  assert.deepEqual(labels(complete("XREAD COUNT 2 ")), ["MAXCOUNT", "MAXSIZE", "BLOCK", "STREAMS"]);
  assert.deepEqual(labels(complete("XREADGROUP ")), ["GROUP"]);
  assert.deepEqual(complete("XREADGROUP GROUP "), []);
  assert.deepEqual(complete("XREADGROUP GROUP workers "), []);
  assert.deepEqual(labels(complete("XREADGROUP GROUP workers consumer-1 ")), ["COUNT", "BLOCK", "NOACK", "STREAMS"]);
  assert.equal(
    complete("XREADGROUP GROUP workers consumer-1 NOACK ").some((item) => item.label === "NOACK"),
    false,
  );
  assert.equal(complete("XREAD COUNT 2 ")[0]?.appendSpace, true);

  const setInput: RedisCompletionInput = {
    keys: [],
    commands: [
      {
        name: "SET",
        keySpecs: oneKey,
        arguments: [
          { name: "key", type: "key" },
          { name: "value", type: "string" },
          {
            name: "condition",
            type: "oneof",
            optional: true,
            arguments: [
              { name: "nx", token: "NX", type: "pure-token" },
              { name: "xx", token: "XX", type: "pure-token" },
            ],
          },
        ],
      },
    ],
  };
  assert.deepEqual(labels(buildRedisCompletionItems("SET account value ", 18, setInput)), ["NX", "XX"]);

  const repeatInput: RedisCompletionInput = {
    commands: [
      {
        name: "SORT",
        keySpecs: oneKey,
        arguments: [
          { name: "key", type: "key" },
          { name: "pattern", token: "GET", type: "string", optional: true, multiple: true, multipleToken: true },
          {
            name: "order",
            type: "oneof",
            optional: true,
            arguments: [
              { name: "asc", token: "ASC", type: "pure-token" },
              { name: "desc", token: "DESC", type: "pure-token" },
            ],
          },
        ],
      },
    ],
  };
  assert.deepEqual(new Set(labels(buildRedisCompletionItems("SORT users GET profile:* ", 25, repeatInput))), new Set(["GET", "ASC", "DESC"]));
});

test("key candidates follow documented range, key-count, and keyword key specs", () => {
  const keys = ["dest", "source:1", "source:2"];
  assert.ok(labels(complete("BITOP AND ", 10, keys)).includes("dest"));
  assert.ok(labels(complete("BITOP AND dest ", 15, keys)).includes("source:1"));
  assert.ok(labels(complete("EVAL script 2 ", 14, keys)).includes("dest"));
  assert.ok(labels(complete("EVAL script 2 dest ", 19, keys)).includes("source:1"));
  assert.ok(labels(complete('EVAL "return 1" 2 ', undefined, keys)).includes("dest"));
  assert.equal(complete("EVAL script 2 dest source:1 ", 29, keys).length, 0);
  assert.ok(labels(complete("XREAD STREAMS ", 14, keys)).includes("dest"));
  assert.equal(complete("XREAD STREAMS dest 0-0 ", 25, keys).length, 0);
  assert.ok(labels(complete("BLPOP ", 6, keys)).includes("dest"));
  assert.equal(complete("BLPOP dest ", 11, keys).length, 0);
  assert.ok(labels(complete("MIGRATE host 6379 source 0 100 KEYS ", 39, keys)).includes("dest"));
});

test("completion parses quoted arguments and safely applies special key names", () => {
  const completionInput = input(["user name", 'quote"key', "plain", "path\\\\name"]);
  const quotedScript = getRedisCompletionContext('EVAL "return 1" 2 ', 18, completionInput);
  assert.deepEqual(quotedScript.argumentValues, ["return 1", "2"]);
  assert.equal(quotedScript.argumentIndex, 2);

  const keyItems = buildRedisCompletionItems('GET "user', 9, completionInput);
  assert.equal(keyItems.find((item) => item.label === "user name")?.apply, '"user name"');
  assert.equal(buildRedisCompletionItems("GET quote", 9, completionInput).find((item) => item.label === 'quote"key')?.apply, '"quote\\"key"');
  assert.equal(buildRedisCompletionItems("GET pl", 6, completionInput).find((item) => item.label === "plain")?.apply, "plain");
  const escapedKey = buildRedisCompletionItems("GET path", 8, completionInput).find((item) => item.label === "path\\\\name")?.apply;
  assert.equal(escapedKey, "path\\\\name");
  assert.deepEqual(
    tokenizeRedisLine(`GET ${escapedKey}`).argv.map((token) => token.value),
    ["GET", "path\\name"],
  );
});

test("non-key arguments and unknown subcommands never produce key candidates", () => {
  const keys = ["user:1"];
  assert.equal(complete("GET key ", 8, keys).length, 0);
  assert.equal(complete("HSET key ", 9, keys).length, 0);
  assert.equal(complete("FLUSHDB ", 8, keys).length, 0);
  assert.equal(complete("OBJECT UNKNOWN ", 15, keys).length, 0);
});

test("takesKeyArgument evaluates the active server-documented argument", () => {
  const completionInput = input();
  assert.equal(takesKeyArgument("GET", completionInput), true);
  assert.equal(takesKeyArgument("BITOP", completionInput, 0, []), false);
  assert.equal(takesKeyArgument("BITOP", completionInput, 1, ["AND"]), true);
  assert.equal(takesKeyArgument("EVAL", completionInput, 2, ["script", "1"]), true);
  assert.equal(takesKeyArgument("EVAL", completionInput, 3, ["script", "1", "key"]), false);
  assert.equal(takesKeyArgument("XREAD", completionInput, 3, ["STREAMS", "key", "0-0"]), false);
  assert.equal(takesKeyArgument("MIGRATE", completionInput, 6, ["host", "6379", "source", "0", "100", "KEYS"]), true);
  assert.equal(takesKeyArgument("FLUSHDB", completionInput), false);
  assert.equal(takesKeyArgument(undefined, completionInput), false);
});

test("context parsing resolves server subcommands and argument positions", () => {
  const completionInput = input();
  assert.deepEqual(getRedisCompletionContext("", 0, completionInput), { mode: "command", prefix: "", from: 0 });
  assert.deepEqual(getRedisCompletionContext("XGROUP ", 7, completionInput), { mode: "subcommand", prefix: "", from: 7, mainCommand: "XGROUP", commandName: "XGROUP" });
  const context = getRedisCompletionContext("EVAL script 2 ", 14, completionInput);
  assert.equal(context.mode, "argument");
  assert.equal(context.commandName, "EVAL");
  assert.equal(context.argumentIndex, 2);
  assert.deepEqual(context.argumentValues, ["script", "2"]);
});

test("automatic completion opens on command and key characters, not a newline", () => {
  assert.equal(shouldAutoOpenRedisCompletion("GET", 3), true);
  assert.equal(shouldAutoOpenRedisCompletion("GET ", 4), true);
  assert.equal(shouldAutoOpenRedisCompletion("GET\n", 4), false);
  assert.equal(shouldAutoOpenRedisCompletion("user:", 5), true);
});

test("completion reuse accepts command-name and key-name characters", () => {
  const re = getRedisCompletionResultValidFor();
  assert.equal(re.test("GET"), true);
  assert.equal(re.test("user:1"), true);
  assert.equal(re.test("a.b-c"), true);
});
