import assert from "node:assert/strict";
import { test } from "vitest";
import { checkMongoScript, isMongoScriptSyntax } from "../../apps/desktop/src/lib/mongo/mongoScriptCheck.ts";
import { MONGO_SCRIPT_MAX_COMMANDS, recordMongoScriptCommands } from "../../apps/desktop/src/lib/mongo/mongoScriptRecorder.ts";
import { parseMongoCommand, splitMongoCommandRanges } from "../../apps/desktop/src/lib/mongo/mongoShellCommand.ts";

function expand(script: string) {
  assert.equal(checkMongoScript(script), null);
  const result = recordMongoScriptCommands(script);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.commands;
}

test("records the db calls a loop makes as editor commands", () => {
  const commands = expand(`for (let i = 0; i < 2; i += 1) {
  db.items.insertOne({ index: i, tags: ["a"] });
}`);

  assert.deepEqual(commands, ['db.getCollection("items").insertOne({"index": 0, "tags": ["a"]})', 'db.getCollection("items").insertOne({"index": 1, "tags": ["a"]})']);
  assert.ok(commands.every((command) => parseMongoCommand(command)?.command.kind === "insert"));
});

test("keeps cursor chains, sibling databases and named collections", () => {
  const commands = expand(`const limit = 5;
db.getSiblingDB("reports").getCollection("daily stats").find({ day: { $gte: 1 } }).sort({ day: -1 }).limit(limit);
db.createCollection("archive");`);

  assert.deepEqual(commands, ['db.getSiblingDB("reports").getCollection("daily stats").find({"day": {"$gte": 1}}).sort({"day": -1}).limit(5)', 'db.createCollection("archive")']);
  assert.equal(parseMongoCommand(commands[0]!)?.command.kind, "inDatabase");
  assert.equal(parseMongoCommand(commands[1]!)?.command.kind, "runCommand");
});

test("serializes BSON helpers so values survive the round trip", () => {
  const [command] = expand(`const id = ObjectId();
const when = new Date("2026-01-02T03:04:05.000Z");
db.events.insertOne({ _id: id, ref: ObjectId("65f000000000000000000001"), when, at: ISODate("2026-01-01T00:00:00Z"), n: NumberInt(5), big: NumberLong("9007199254740993"), price: NumberDecimal("1.50"), name: /ad+a/i, skipped: undefined });`);

  assert.match(
    command!,
    /^db\.getCollection\("events"\)\.insertOne\(\{"_id": ObjectId\("[0-9a-f]{24}"\), "ref": ObjectId\("65f000000000000000000001"\), "when": ISODate\("2026-01-02T03:04:05\.000Z"\), "at": ISODate\("2026-01-01T00:00:00\.000Z"\), "n": NumberInt\("5"\), "big": NumberLong\("9007199254740993"\), "price": NumberDecimal\("1\.50"\), "name": \/ad\+a\/i\}\)$/,
  );
  const parsed = parseMongoCommand(command!)?.command;
  assert.equal(parsed?.kind, "insert");
});

test("an ObjectId held in a variable is the same in every call", () => {
  const commands = expand(`const id = ObjectId();
db.a.insertOne({ _id: id });
db.b.insertOne({ ref: id });`);
  const ids = commands.map((command) => /ObjectId\("([0-9a-f]{24})"\)/.exec(command)?.[1]);

  assert.ok(ids[0]);
  assert.equal(ids[0], ids[1]);
});

test("rejects scripts that read a db call's result", () => {
  for (const script of [
    "const doc = db.users.findOne({ _id: 1 });",
    "if (!db.users.findOne({ _id: 1 })) { db.users.insertOne({ _id: 1 }); }",
    "db.users.countDocuments() > 0 && db.users.drop();",
    "[1, 2].map((i) => db.items.insertOne({ i }));",
    "const handle = db; handle.users.drop();",
    "db.a.insertOne({ copy: db.b.findOne() });",
    "function run(db) { db.x.drop(); }",
  ]) {
    assert.match(checkMongoScript(script) ?? "", /cannot read query results/, script);
  }
});

test("rejects ways around the static check", () => {
  assert.match(checkMongoScript('eval("db.users.findOne()")') ?? "", /eval is not supported/);
  assert.match(checkMongoScript("(function () { arguments[0]; })();") ?? "", /arguments is not supported/);
});

test("rejects cursor callbacks, which would need query results", () => {
  const result = recordMongoScriptCommands("db.users.find({}).forEach(function (doc) { print(doc); });");

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /callbacks such as forEach\(\)/);
});

test("reports script errors, empty scripts and runaway loops", () => {
  const missing = recordMongoScriptCommands("db.users.find({ name: missingName });");
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.error, /missingName is not defined/);

  const empty = recordMongoScriptCommands("const x = 1;");
  assert.deepEqual(empty, { ok: false, error: "The script made no database calls." });

  const runaway = recordMongoScriptCommands("for (let i = 0; ; i += 1) { db.items.insertOne({ i }); }");
  assert.equal(runaway.ok, false);
  assert.match(runaway.ok ? "" : runaway.error, new RegExp(`more than ${MONGO_SCRIPT_MAX_COMMANDS}`));
});

test("only JavaScript that parses goes down the script path", () => {
  assert.equal(isMongoScriptSyntax("for (let i = 0; i < 2; i++) { db.items.insertOne({ i }); }"), true);
  assert.equal(isMongoScriptSyntax("db.items.find({ a: 1 }"), false);
});

test("plain command splitting never runs scripts", () => {
  assert.deepEqual(splitMongoCommandRanges("for (;;) { db.items.insertOne({}); }"), []);
});
