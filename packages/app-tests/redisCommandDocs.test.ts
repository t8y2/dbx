import assert from "node:assert/strict";
import { test } from "vitest";
import { mergeRedisCommandDocumentation, parseRedisCommandCatalog, parseRedisCommandDocumentation } from "../../apps/desktop/src/lib/redis/redisCommandDocs.ts";

test("parses COMMAND DOCS maps emitted by the Redis bridge", () => {
  const docs = parseRedisCommandDocumentation([
    {
      key: "get",
      value: [
        { key: "summary", value: "Returns the string value of a key." },
        { key: "since", value: "1.0.0" },
        { key: "group", value: "string" },
        { key: "arity", value: 2 },
        {
          key: "key_specs",
          value: [
            [
              {
                key: "begin_search",
                value: [
                  { key: "type", value: "index" },
                  { key: "spec", value: [{ key: "index", value: 1 }] },
                ],
              },
              {
                key: "find_keys",
                value: [
                  { key: "type", value: "range" },
                  {
                    key: "spec",
                    value: [
                      { key: "lastkey", value: 0 },
                      { key: "keystep", value: 1 },
                    ],
                  },
                ],
              },
            ],
          ],
        },
      ],
    },
    {
      key: "acl cat",
      value: [
        { key: "summary", value: "Lists ACL categories." },
        { key: "group", value: "server" },
        { key: "arity", value: -2 },
      ],
    },
  ]);

  assert.deepEqual(docs, [
    { name: "ACL CAT", summary: "Lists ACL categories.", since: undefined, group: "server", arity: -2, keySpecs: [] },
    {
      name: "GET",
      summary: "Returns the string value of a key.",
      since: "1.0.0",
      group: "string",
      arity: 2,
      keySpecs: [{ beginSearch: { type: "index", index: 1 }, findKeys: { type: "range", lastKey: 0, keyStep: 1, limit: 0 } }],
    },
  ]);
});

test("parses nested subcommands from a COMMAND DOCS response", () => {
  const docs = parseRedisCommandDocumentation([
    {
      key: "acl",
      value: [
        { key: "summary", value: "A container for Access List Control commands." },
        { key: "group", value: "server" },
        { key: "arity", value: -2 },
        {
          key: "subcommands",
          value: [
            {
              key: "acl|cat",
              value: [
                { key: "summary", value: "Lists ACL categories." },
                { key: "group", value: "server" },
                { key: "arity", value: -2 },
              ],
            },
          ],
        },
      ],
    },
  ]);

  assert.deepEqual(docs, [
    { name: "ACL", summary: "A container for Access List Control commands.", since: undefined, group: "server", arity: -2, keySpecs: [] },
    { name: "ACL CAT", summary: "Lists ACL categories.", since: undefined, group: "server", arity: -2, keySpecs: [] },
  ]);
});

test("parses COMMAND DOCS maps returned through RESP2", () => {
  const docs = parseRedisCommandDocumentation(["get", ["summary", "Returns the string value of a key.", "since", "1.0.0", "group", "string", "arity", 2, "key_specs", [["begin_search", ["type", "index", "spec", ["index", 1]], "find_keys", ["type", "range", "spec", ["lastkey", 0, "keystep", 1]]]]]]);

  assert.deepEqual(docs, [
    {
      name: "GET",
      summary: "Returns the string value of a key.",
      since: "1.0.0",
      group: "string",
      arity: 2,
      keySpecs: [{ beginSearch: { type: "index", index: 1 }, findKeys: { type: "range", lastKey: 0, keyStep: 1, limit: 0 } }],
    },
  ]);
});

test("parses keyword and key-count specs from COMMAND DOCS", () => {
  const docs = parseRedisCommandDocumentation({
    xread: {
      key_specs: [
        {
          begin_search: { type: "keyword", spec: { keyword: "STREAMS", startfrom: 1 } },
          find_keys: { type: "range", spec: { lastkey: -1, keystep: 1, limit: 2 } },
        },
      ],
    },
    eval: {
      key_specs: [
        {
          begin_search: { type: "index", spec: { index: 2 } },
          find_keys: { type: "keynum", spec: { keynumidx: 0, firstkey: 1, keystep: 1 } },
        },
      ],
    },
    migrate: {
      key_specs: [
        {
          begin_search: { type: "keyword", spec: { keyword: "KEYS", startfrom: -2 } },
          find_keys: { type: "range", spec: { lastkey: -1, keystep: 1, limit: 0 } },
        },
      ],
    },
  });

  assert.deepEqual(docs, [
    { name: "EVAL", summary: undefined, since: undefined, group: undefined, arity: undefined, keySpecs: [{ beginSearch: { type: "index", index: 2 }, findKeys: { type: "keynum", keyNumIndex: 0, firstKey: 1, keyStep: 1 } }] },
    { name: "MIGRATE", summary: undefined, since: undefined, group: undefined, arity: undefined, keySpecs: [{ beginSearch: { type: "keyword", keyword: "KEYS", startFrom: -2 }, findKeys: { type: "range", lastKey: -1, keyStep: 1, limit: 0 } }] },
    { name: "XREAD", summary: undefined, since: undefined, group: undefined, arity: undefined, keySpecs: [{ beginSearch: { type: "keyword", keyword: "STREAMS", startFrom: 1 }, findKeys: { type: "range", lastKey: -1, keyStep: 1, limit: 2 } }] },
  ]);
});

test("parses the recursive argument grammar from COMMAND DOCS", () => {
  const [xread] = parseRedisCommandDocumentation({
    xread: {
      arguments: [
        { name: "count", token: "count", type: "integer", summary: "Limits the number of entries.", since: "5.0.0", optional: 1 },
        {
          name: "streams",
          token: "STREAMS",
          type: "block",
          arguments: [
            { name: "key", type: "key", multiple: 1, multiple_token: 1 },
            { name: "ID", type: "string", multiple: true },
          ],
        },
        {
          name: "condition",
          type: "oneof",
          optional: "1",
          arguments: [
            { name: "nx", token: "NX", type: "pure-token" },
            { name: "xx", token: "XX", type: "pure-token" },
          ],
        },
      ],
    },
  });

  assert.deepEqual(xread?.arguments, [
    { name: "count", token: "COUNT", type: "integer", summary: "Limits the number of entries.", since: "5.0.0", optional: true },
    {
      name: "streams",
      token: "STREAMS",
      type: "block",
      arguments: [
        { name: "key", type: "key", multiple: true, multipleToken: true },
        { name: "ID", type: "string", multiple: true },
      ],
    },
    {
      name: "condition",
      type: "oneof",
      optional: true,
      arguments: [
        { name: "nx", token: "NX", type: "pure-token" },
        { name: "xx", token: "XX", type: "pure-token" },
      ],
    },
  ]);
});

test("parses argument behavior from Redis flags arrays", () => {
  const [command] = parseRedisCommandDocumentation({
    example: {
      arguments: [
        { name: "key", type: "key", flags: ["optional", "multiple"] },
        { name: "value", type: "string", flags: ["multiple-token"] },
      ],
    },
  });

  assert.deepEqual(command?.arguments, [
    { name: "key", type: "key", optional: true, multiple: true },
    { name: "value", type: "string", multipleToken: true },
  ]);
});

test("parses the legacy COMMAND catalog including nested subcommands", () => {
  const docs = parseRedisCommandCatalog([
    ["get", 2, ["readonly", "fast"], 1, 1, 1, ["@read"], [], [], []],
    ["blpop", -3, ["write"], 1, -2, 1, ["@write"], [], [], []],
    ["acl", -2, ["admin"], 0, 0, 0, ["@admin"], [], [], [["acl|cat", -2, ["readonly"], 0, 0, 0, ["@read"], [], [], []]]],
  ]);

  assert.deepEqual(docs, [
    { name: "ACL", summary: undefined, since: undefined, group: undefined, arity: -2, keySpecs: [] },
    { name: "ACL CAT", summary: undefined, since: undefined, group: undefined, arity: -2, keySpecs: [] },
    { name: "BLPOP", summary: undefined, since: undefined, group: undefined, arity: -3, keySpecs: [{ beginSearch: { type: "index", index: 1 }, findKeys: { type: "range", lastKey: -2, keyStep: 1, limit: 0 } }] },
    { name: "GET", summary: undefined, since: undefined, group: undefined, arity: 2, keySpecs: [{ beginSearch: { type: "index", index: 1 }, findKeys: { type: "range", lastKey: 0, keyStep: 1, limit: 0 } }] },
  ]);
});

test("fills COMMAND DOCS key positions and arity from COMMAND", () => {
  const docs = parseRedisCommandDocumentation({
    get: { summary: "Returns a value.", arguments: [{ name: "key", type: "key" }] },
  });
  const catalog = parseRedisCommandCatalog([
    ["get", 2, ["readonly"], 1, 1, 1, ["@read"], [], [], []],
  ]);

  assert.deepEqual(mergeRedisCommandDocumentation(docs, catalog), [
    {
      name: "GET",
      summary: "Returns a value.",
      since: undefined,
      group: undefined,
      arity: 2,
      keySpecs: [{ beginSearch: { type: "index", index: 1 }, findKeys: { type: "range", lastKey: 0, keyStep: 1, limit: 0 } }],
      arguments: [{ name: "key", type: "key" }],
    },
  ]);
});
