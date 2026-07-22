import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  describeMongoCommandParseFailure,
  evaluateMongoAggregateSafety,
  evaluateMongoWriteSafety,
  mongoAggregateWriteStage,
  mongoCollectionStatsToQueryResult,
  mongoCountToQueryResult,
  mongoDistinctToQueryResult,
  mongoDocumentsToQueryResult,
  mongoIndexesToQueryResult,
  normalizeRustMongoCommand,
  parseMongoAggregateCommand,
  parseMongoCollectionStatsCommand,
  parseMongoCommand,
  parseMongoCountDocumentsCommand,
  parseMongoDistinctCommand,
  parseMongoFindCommand,
  parseMongoFindOneCommand,
  parseMongoFindOneAndUpdateCommand,
  parseMongoFindOneAndReplaceCommand,
  parseMongoFindOneAndDeleteCommand,
  parseMongoGetIndexesCommand,
  parseMongoVersionCommand,
  parseMongoWriteCommand,
  splitMongoCommands,
  splitMongoCommandRanges,
} from "../../apps/desktop/src/lib/mongo/mongoShellCommand.ts";
import type { MongoWriteCommand } from "../../apps/desktop/src/lib/mongo/mongoShellCommand.ts";
import { buildMongoUpdateDocument as buildMongoDocumentUpdate, formatMongoShellLiteral as formatMongoDocumentShellLiteral } from "../../apps/desktop/src/lib/mongo/mongoDocumentValues.ts";

test("parseMongoFindCommand parses db collection find with an empty JSON filter", () => {
  assert.deepEqual(parseMongoFindCommand("db.users.find({})"), {
    collection: "users",
    filter: "{}",
    skip: 0,
    limit: 100,
    sort: undefined,
  });
});

test("normalizeRustMongoCommand preserves the desktop command contract", () => {
  assert.deepEqual(normalizeRustMongoCommand({ kind: "countDocuments", collection: "users", filter: "{}", accurate: false }), { kind: "countDocuments", collection: "users", filter: "{}", mode: "legacy" });
  assert.deepEqual(normalizeRustMongoCommand({ kind: "dropIndexes", collection: "users", indexes: '"email_1"', single: true }), { kind: "dropIndex", collection: "users", index: '"email_1"' });
  assert.deepEqual(normalizeRustMongoCommand({ kind: "findOne", collection: "users", filter: "{}", projection: null, options: null }), { kind: "findOne", collection: "users", filter: "{}" });
});

test("parseMongoFindCommand parses getCollection find with chained sort skip and limit", () => {
  assert.deepEqual(parseMongoFindCommand('db.getCollection("audit.logs").find({"level":"warn"}).sort({"createdAt":-1}).skip(20).limit(10)'), {
    collection: "audit.logs",
    filter: '{"level":"warn"}',
    skip: 20,
    limit: 10,
    sort: '{"createdAt":-1}',
  });
});

test("parseMongoFindCommand accepts line breaks before find and chained calls", () => {
  const command = parseMongoFindCommand(`db.getCollection("accounting_reconciliations")
.find({
  "_id": ObjectId("68ad51ca84c8127bc7d44cb3")
})
.sort({ lineNo: -1 })
.skip(5)
.limit(20)`);
  assert.ok(command);
  assert.equal(command.collection, "accounting_reconciliations");
  assert.deepEqual(JSON.parse(command.filter), { _id: { $oid: "68ad51ca84c8127bc7d44cb3" } });
  assert.deepEqual(JSON.parse(command.sort || "{}"), { lineNo: -1 });
  assert.equal(command.skip, 5);
  assert.equal(command.limit, 20);
});

test("parseMongoFindCommand accepts Compass-style unquoted keys and ObjectId", () => {
  const command = parseMongoFindCommand("db.products.find({_id: ObjectId('6a045a92d2971e44243771a1')}).limit(1)");
  assert.ok(command);
  assert.equal(command.collection, "products");
  assert.equal(command.limit, 1);
  assert.deepEqual(JSON.parse(command.filter), { _id: { $oid: "6a045a92d2971e44243771a1" } });
});

test("parseMongoFindCommand does not rewrite NumberLong text inside strings", () => {
  const command = parseMongoFindCommand('db.orders.find({label: "NumberLong(123)"})');
  assert.deepEqual(command, {
    collection: "orders",
    filter: '{"label": "NumberLong(123)"}',
    skip: 0,
    limit: 100,
    sort: undefined,
  });
});

test("parseMongoFindCommand rewrites ISODate into extended JSON $date", () => {
  const command = parseMongoFindCommand(`db.trainingdocuments.find({
    createdAt: { $gte: ISODate("2025-02-25T04:57:39.965Z") }
  })`);
  assert.ok(command);
  assert.equal(command.collection, "trainingdocuments");
  assert.deepEqual(JSON.parse(command.filter), { createdAt: { $gte: { $date: "2025-02-25T04:57:39.965Z" } } });
});

test("parseMongoFindCommand rewrites new Date and single-quoted ISODate", () => {
  const command = parseMongoFindCommand("db.events.find({ at: { $lt: new Date('2025-01-01T00:00:00Z'), $gte: ISODate('2024-01-01T00:00:00Z') } })");
  assert.ok(command);
  assert.deepEqual(JSON.parse(command.filter), {
    at: { $lt: { $date: "2025-01-01T00:00:00Z" }, $gte: { $date: "2024-01-01T00:00:00Z" } },
  });
});

test("parseMongoFindCommand rewrites NumberLong into extended JSON", () => {
  const quoted = parseMongoFindCommand('db.orders.find({_id: NumberLong("2048938405781032962")})');
  const unquoted = parseMongoFindCommand("db.orders.find({snowflake: NumberLong(9007199254740993)})");

  assert.ok(quoted);
  assert.deepEqual(JSON.parse(quoted.filter), { _id: { $numberLong: "2048938405781032962" } });
  assert.ok(unquoted);
  assert.deepEqual(JSON.parse(unquoted.filter), { snowflake: { $numberLong: "9007199254740993" } });
});

test("parseMongoFindCommand accepts single-quoted string values and unquoted sort keys", () => {
  const command = parseMongoFindCommand("db.products.find({category: 'Electronics'}).sort({price: -1}).limit(2)");
  assert.ok(command);
  assert.equal(command.collection, "products");
  assert.equal(command.limit, 2);
  assert.deepEqual(JSON.parse(command.filter), { category: "Electronics" });
  assert.deepEqual(JSON.parse(command.sort || "{}"), { price: -1 });
});

test("parseMongoFindCommand parses projection arguments", () => {
  const command = parseMongoFindCommand(`db.jobs.find({ status: "open" }, {
    title: 1,
    _id: 0
  }).sort({ title: 1 })`);
  assert.ok(command);
  assert.equal(command.collection, "jobs");
  assert.deepEqual(JSON.parse(command.filter), { status: "open" });
  assert.deepEqual(JSON.parse(command.projection || "{}"), { title: 1, _id: 0 });
  assert.deepEqual(JSON.parse(command.sort || "{}"), { title: 1 });
});

test("parseMongoFindCommand rejects unsupported mongo shell commands", () => {
  assert.equal(parseMongoFindCommand("db.users.drop()"), null);
  assert.equal(parseMongoFindCommand("db.users.find({}, {}, { hint: { name: 1 } })"), null);
});

test("parseMongoFindOneCommand parses a dedicated findOne command", () => {
  assert.deepEqual(parseMongoFindOneCommand("db.users.findOne({email:'a@b.com'})"), {
    collection: "users",
    filter: '{"email":"a@b.com"}',
  });
});

test("parseMongoFindOneCommand defaults an empty filter and parses projection", () => {
  assert.deepEqual(parseMongoFindOneCommand("db.users.findOne()"), {
    collection: "users",
    filter: "{}",
  });
  const withProjection = parseMongoFindOneCommand('db.getCollection("audit.logs").findOne({ level: "warn" }, { message: 1, _id: 0 })');
  assert.ok(withProjection);
  assert.equal(withProjection.collection, "audit.logs");
  assert.deepEqual(JSON.parse(withProjection.projection || "{}"), { message: 1, _id: 0 });
});

test("parseMongoFindOneCommand accepts documented projection and options arguments", () => {
  const command = parseMongoFindOneCommand("db.users.findOne({ active: true }, { name: 1 }, { sort: { createdAt: -1 } })");
  assert.ok(command);
  assert.deepEqual(JSON.parse(command.filter), { active: true });
  assert.deepEqual(JSON.parse(command.projection || "{}"), { name: 1 });
  assert.deepEqual(JSON.parse(command.options || "{}"), { sort: { createdAt: -1 } });
});

test("parseMongoFindOneCommand rejects cursor chaining and does not collide with find", () => {
  assert.equal(parseMongoFindOneCommand("db.users.findOne({}).limit(5)"), null);
  assert.equal(parseMongoFindOneCommand("db.users.find({})"), null);
});

test("parseMongoCommand tags findOne with its own kind", () => {
  const parsed = parseMongoCommand("db.users.findOne({active:true})");
  assert.deepEqual(parsed?.command, {
    kind: "findOne",
    collection: "users",
    filter: '{"active":true}',
  });
});

test("parseMongoFindOneAndUpdateCommand parses filter, update and options", () => {
  assert.deepEqual(parseMongoFindOneAndUpdateCommand("db.users.findOneAndUpdate({_id:1},{$set:{active:true}},{returnDocument:'after'})"), {
    collection: "users",
    filter: '{"_id":1}',
    update: '{"$set":{"active":true}}',
    options: '{"returnDocument":"after"}',
  });
  // requires both filter and update
  assert.equal(parseMongoFindOneAndUpdateCommand("db.users.findOneAndUpdate({_id:1})"), null);
});

test("parseMongoFindOneAndReplaceCommand parses filter and replacement", () => {
  assert.deepEqual(parseMongoFindOneAndReplaceCommand("db.users.findOneAndReplace({_id:1},{name:'a'})"), {
    collection: "users",
    filter: '{"_id":1}',
    replacement: '{"name":"a"}',
  });
});

test("parseMongoFindOneAndDeleteCommand parses filter and defaults empty", () => {
  assert.deepEqual(parseMongoFindOneAndDeleteCommand("db.users.findOneAndDelete({_id:1})"), {
    collection: "users",
    filter: '{"_id":1}',
  });
  assert.deepEqual(parseMongoFindOneAndDeleteCommand("db.users.findOneAndDelete()"), {
    collection: "users",
    filter: "{}",
  });
});

test("parseMongoCommand tags find-and-modify commands with their kind", () => {
  assert.equal(parseMongoCommand("db.users.findOneAndUpdate({_id:1},{$set:{a:1}})")?.command.kind, "findOneAndUpdate");
  assert.equal(parseMongoCommand("db.users.findOneAndReplace({_id:1},{a:1})")?.command.kind, "findOneAndReplace");
  assert.equal(parseMongoCommand("db.users.findOneAndDelete({_id:1})")?.command.kind, "findOneAndDelete");
  // findOne must not be swallowed by the find-and-modify parsers
  assert.equal(parseMongoCommand("db.users.findOne({_id:1})")?.command.kind, "findOne");
});

test("evaluateMongoWriteSafety blocks empty-filter find-and-modify unless dangerous", () => {
  const command = parseMongoCommand("db.users.findOneAndDelete({})")?.command as MongoWriteCommand;
  assert.ok(command);
  assert.equal(evaluateMongoWriteSafety(command, { allowWrites: true, allowDangerous: false }).allowed, false);
  assert.equal(evaluateMongoWriteSafety(command, { allowWrites: true, allowDangerous: true }).allowed, true);
});

test("evaluateMongoWriteSafety fails closed for opaque or effectively unbounded filters", () => {
  for (const source of [
    'db.users.deleteMany({"$nor":[{"$expr":false}]})',
    'db.users.deleteMany({"$or":[{"id":{"$exists":true}},{"id":{"$exists":false}}]})',
    'db.users.deleteMany({"$or":[{"id":{"$exists":true}},{"id":{"$not":{"$exists":true}}}]})',
    'db.users.deleteMany({"$or":[{"id":{"$eq":1}},{"id":{"$ne":1}}]})',
    'db.users.deleteMany({"$or":[{"$and":[{"id":{"$eq":1}}]},{"id":{"$ne":1}}]})',
    'db.users.deleteMany({"$or":[{"$and":[{"id":{"$eq":1}},{}]},{"id":{"$ne":1}}]})',
    'db.users.deleteMany({"$or":[{"$and":[{"id":{"$eq":1}},{"x":{"$exists":true}}]},{"id":{"$ne":1}},{"x":{"$exists":false}}]})',
    'db.users.deleteMany({"$or":[{"id":1},{"id":{"$ne":1}}]})',
    'db.users.deleteMany({"$or":[{"id":{"$gt":1}},{"id":{"$lte":1}}]})',
    'db.users.deleteMany({"$or":[{"id":{"$gte":1}},{"id":{"$lt":1}}]})',
    'db.users.deleteMany({"$or":[{"id":{"$in":[1,2]}},{"id":{"$nin":[2,1]}}]})',
    'db.users.deleteMany({"_id":{"$exists":true}})',
    'db.users.deleteMany({"id":{"$nin":[]}})',
    'db.users.deleteMany({"id":{"$elemMatch":{"value":1}}})',
    'db.users.deleteMany({"_id":{"$oid":"not-an-object-id"}})',
    'db.users.deleteMany({"sequence":{"$numberLong":"9223372036854775808"}})',
    'db.users.deleteMany({"created_at":{"$date":"2026-02-30T00:00:00Z"}})',
    'db.users.deleteMany({"name":{"$regex":".*"}})',
    'db.users.deleteMany({"$or":[{"_id":{"$oid":"507f1f77bcf86cd799439011"}},{"_id":{"$ne":{"$oid":"507f1f77bcf86cd799439011"}}}]})',
    'db.users.updateMany({"$where":"true"},{"$set":{"active":false}})',
    'db.users.deleteMany({"$or":[]})',
    'db.users.deleteMany({"$opaque":[{"id":1}]})',
  ]) {
    const command = parseMongoWriteCommand(source);
    assert.ok(command, source);
    assert.equal(evaluateMongoWriteSafety(command, { allowWrites: true, allowDangerous: false }).allowed, false, source);
    assert.equal(evaluateMongoWriteSafety(command, { allowWrites: true, allowDangerous: true }).allowed, true, source);
  }

  for (const source of [
    'db.users.deleteMany({"tenant_id":1})',
    'db.users.updateMany({"created_at":{"$gte":"2026-01-01"}},{"$set":{"active":false}})',
    'db.users.deleteMany({"$or":[{"tenant_id":1},{"tenant_id":2}]})',
    'db.users.deleteMany({"id":{"$ne":1}})',
    'db.users.deleteMany({"id":{"$in":[1,2]}})',
    'db.users.deleteMany({"id":{"$exists":true}})',
    'db.users.updateOne({_id:ObjectId("507f1f77bcf86cd799439011")},{"$set":{"active":true}})',
    'db.users.deleteMany({"sequence":NumberLong("9223372036854775807")})',
    'db.users.deleteMany({"created_at":ISODate("2026-01-01T00:00:00.000Z")})',
    'db.users.deleteMany({"tenant_id":1,"id":{"$nin":[]}})',
  ]) {
    const command = parseMongoWriteCommand(source);
    assert.ok(command, source);
    assert.equal(evaluateMongoWriteSafety(command, { allowWrites: true, allowDangerous: false }).allowed, true, source);
  }
});

test("parseMongoVersionCommand parses db.version", () => {
  assert.deepEqual(parseMongoVersionCommand("db.version();"), { kind: "version" });
  assert.equal(parseMongoVersionCommand("db.jobs.version()"), null);
});

test("parseMongoCommand normalizes outer comments around a command", () => {
  const parsed = parseMongoCommand(`
    // current database
    use accounting;
    // keep working here
  `);
  assert.deepEqual(parsed, {
    text: "use accounting;",
    command: {
      kind: "use",
      database: "accounting",
    },
  });
});

test("parseMongoCommand strips SQL-style -- comments the editor inserts", () => {
  // The editor runs Mongo through its SQL language mode, whose line comment is `--`.
  assert.equal(parseMongoCommand("-- current database\ndb.users.find({})")?.command.kind, "find");
  assert.equal(parseMongoCommand("db.users.find({}) -- run this one")?.command.kind, "find");
  assert.equal(parseMongoCommand("/* header */ db.users.find({}) -- trailer")?.command.kind, "find");
  // Native // comments still work alongside --.
  assert.equal(parseMongoCommand("// keep\ndb.users.find({})")?.command.kind, "find");
});

test("parseMongoCommand keeps comment markers that live inside string values", () => {
  // A `--` or `//` inside a string must not be trimmed as a trailing comment.
  const dash = parseMongoFindCommand('db.users.find({ note: "a--b" })');
  assert.ok(dash);
  assert.deepEqual(JSON.parse(dash.filter), { note: "a--b" });
  const slash = parseMongoFindCommand('db.users.find({ url: "http://x" })');
  assert.ok(slash);
  assert.deepEqual(JSON.parse(slash.filter), { url: "http://x" });
});

test("splitMongoCommands splits statements separated by -- comment lines", () => {
  const commands = splitMongoCommands(`
    -- seed two rows
    db.users.insertOne({ name: "A" });
    db.users.insertOne({ name: "B" }) -- second
  `);
  assert.deepEqual(
    commands.map(({ command }) => command.kind),
    ["insert", "insert"],
  );
});

test("parseMongoWriteCommand accepts unquoted insert and update commands", () => {
  assert.deepEqual(parseMongoWriteCommand("db.products.insertOne({name: 'demo', price: 1})"), {
    kind: "insert",
    collection: "products",
    docsJson: '{"name": "demo", "price": 1}',
  });
  assert.deepEqual(parseMongoWriteCommand("db.products.updateOne({_id: ObjectId('507f1f77bcf86cd799439011')}, {$set: {stock: 3}})"), {
    kind: "update",
    collection: "products",
    filter: '{"_id": {"$oid":"507f1f77bcf86cd799439011"}}',
    update: '{"$set": {"stock": 3}}',
    many: false,
  });
});

test("parseMongoWriteCommand accepts legacy insert commands", () => {
  assert.deepEqual(
    parseMongoWriteCommand(`db.getCollection("accounting_reconciliations").insert({
      "accountId": 999,
      "status": "done"
    });`),
    {
      kind: "insert",
      collection: "accounting_reconciliations",
      docsJson: '{\n      "accountId": 999,\n      "status": "done"\n    }',
    },
  );
  assert.deepEqual(parseMongoWriteCommand("db.products.insert([{name: 'first'}, {name: 'second'}])"), {
    kind: "insert",
    collection: "products",
    docsJson: '[{"name": "first"}, {"name": "second"}]',
  });
  assert.deepEqual(parseMongoWriteCommand("db.products.insertMany([{name: 'first'}, {name: 'second'}])"), {
    kind: "insert",
    collection: "products",
    docsJson: '[{"name": "first"}, {"name": "second"}]',
  });
  assert.equal(parseMongoWriteCommand("db.products.insert({name: 'demo'}, {writeConcern: {w: 1}})"), null);
  assert.equal(parseMongoWriteCommand("db.products.insert()"), null);
  assert.equal(parseMongoWriteCommand("db.products.insert('demo')"), null);
});

test("parseMongoWriteCommand accepts updateMany arrayFilters options", () => {
  assert.deepEqual(
    parseMongoWriteCommand(`db.issue_3231.updateMany(
      { msgType: 3, "order.orderId": { $in: [12345] } },
      { $set: { "order.$[orderElem].bcorderproducts.$[prodElem].pankouType": "双双2" } },
      { arrayFilters: [
        { "orderElem.orderId": { $in: [12345] } },
        { "prodElem.id": 322678 }
      ] }
    )`),
    {
      kind: "update",
      collection: "issue_3231",
      filter: '{ "msgType": 3, "order.orderId": { "$in": [12345] } }',
      update: '{ "$set": { "order.$[orderElem].bcorderproducts.$[prodElem].pankouType": "双双2" } }',
      options: '{ "arrayFilters": [\n        { "orderElem.orderId": { "$in": [12345] } },\n        { "prodElem.id": 322678 }\n      ] }',
      many: true,
    },
  );
});

test("parseMongoWriteCommand parses createIndex with optional options", () => {
  assert.deepEqual(parseMongoWriteCommand("db.users.createIndex({email: 1}, {unique: true, name: 'users_email_unique'})"), {
    kind: "createIndex",
    collection: "users",
    keys: '{"email": 1}',
    options: '{"unique": true, "name": "users_email_unique"}',
  });
});

test("parseMongoWriteCommand parses dropIndex and dropIndexes variants", () => {
  assert.deepEqual(parseMongoWriteCommand('db.users.dropIndex("users_email_unique")'), {
    kind: "dropIndex",
    collection: "users",
    index: '"users_email_unique"',
  });
  assert.deepEqual(parseMongoWriteCommand("db.users.dropIndex({email: 1})"), {
    kind: "dropIndex",
    collection: "users",
    index: '{"email": 1}',
  });
  assert.deepEqual(parseMongoWriteCommand("db.users.dropIndexes()"), {
    kind: "dropIndexes",
    collection: "users",
  });
  assert.deepEqual(parseMongoWriteCommand("db.users.dropIndexes({email: 1})"), {
    kind: "dropIndexes",
    collection: "users",
    indexes: '{"email": 1}',
  });
  assert.deepEqual(parseMongoWriteCommand('db.users.dropIndexes("*")'), {
    kind: "dropIndexes",
    collection: "users",
    indexes: '"*"',
  });
  assert.deepEqual(parseMongoWriteCommand('db.users.dropIndexes(["a_1", "b_1"])'), {
    kind: "dropIndexes",
    collection: "users",
    indexes: '["a_1", "b_1"]',
  });
});

test("parseMongoWriteCommand parses collection drop commands", () => {
  assert.deepEqual(parseMongoWriteCommand("db.users.drop()"), {
    kind: "dropCollection",
    collection: "users",
  });
  assert.deepEqual(parseMongoWriteCommand('db.getCollection("audit.logs").drop();'), {
    kind: "dropCollection",
    collection: "audit.logs",
  });
  assert.deepEqual(parseMongoCommand("db.users.drop()")?.command, {
    kind: "dropCollection",
    collection: "users",
  });
});

test("parseMongoWriteCommand rejects collection drop arguments", () => {
  assert.equal(parseMongoWriteCommand("db.users.drop({ writeConcern: 1 })"), null);
});

test("parseMongoWriteCommand rejects invalid dropIndex/dropIndexes variants", () => {
  assert.equal(parseMongoWriteCommand("db.users.dropIndex()"), null);
  assert.equal(parseMongoWriteCommand('db.users.dropIndex("*")'), null);
  assert.equal(parseMongoWriteCommand('db.users.dropIndex(["a_1"])'), null);
  assert.equal(parseMongoWriteCommand('db.users.dropIndexes([{"a":1}])'), null);
});

test("evaluateMongoWriteSafety blocks collection drop unless dangerous writes are enabled", () => {
  const dropCollection = parseMongoWriteCommand("db.users.drop()");
  assert.ok(dropCollection);
  assert.match(evaluateMongoWriteSafety(dropCollection, { allowWrites: true }).reason || "", /high-risk operations.*DBX MCP settings/i);
  assert.equal(evaluateMongoWriteSafety(dropCollection, { allowWrites: true, allowDangerous: true }).allowed, true);
});

test("evaluateMongoWriteSafety requires high-risk permission for schema changes", () => {
  const dropAll = parseMongoWriteCommand("db.users.dropIndexes()");
  assert.ok(dropAll);
  assert.match(evaluateMongoWriteSafety(dropAll, { allowWrites: true }).reason || "", /high-risk operations.*DBX MCP settings/i);

  const dropOne = parseMongoWriteCommand('db.users.dropIndexes("users_email_unique")');
  assert.ok(dropOne);
  assert.equal(evaluateMongoWriteSafety(dropOne, { allowWrites: true }).allowed, false);
  assert.equal(evaluateMongoWriteSafety(dropOne, { allowWrites: true, allowDangerous: true }).allowed, true);
});

test("parseMongoCountDocumentsCommand parses db collection countDocuments", () => {
  assert.deepEqual(parseMongoCountDocumentsCommand("db.products.countDocuments({})"), {
    collection: "products",
    filter: "{}",
    mode: "accurate",
  });
});

test("parseMongoCountDocumentsCommand parses legacy count helpers", () => {
  assert.deepEqual(parseMongoCountDocumentsCommand("db.products.count({ active: true })"), {
    collection: "products",
    filter: '{ "active": true }',
    mode: "legacy",
  });
  assert.deepEqual(parseMongoCountDocumentsCommand('db.getCollection("audit.logs").count()'), {
    collection: "audit.logs",
    filter: "{}",
    mode: "legacy",
  });
  assert.deepEqual(parseMongoCountDocumentsCommand("db.products.find({ active: true }).count()"), {
    collection: "products",
    filter: '{ "active": true }',
    mode: "legacy",
  });
  assert.equal(parseMongoFindCommand("db.products.find({ active: true }).count()"), null);
  assert.deepEqual(parseMongoCommand("db.products.find({ active: true }).count()")?.command, {
    kind: "countDocuments",
    collection: "products",
    filter: '{ "active": true }',
    mode: "legacy",
  });
});

test("parseMongoAggregateCommand parses db collection aggregate", () => {
  assert.deepEqual(parseMongoAggregateCommand('db.products.aggregate([{"$match":{"active":true}},{"$count":"total"}])'), {
    collection: "products",
    pipeline: '[{"$match":{"active":true}},{"$count":"total"}]',
  });
});

test("parseMongoAggregateCommand accepts an empty pipeline", () => {
  assert.deepEqual(parseMongoAggregateCommand("db.products.aggregate([])"), {
    collection: "products",
    pipeline: "[]",
  });
});

test("parseMongoAggregateCommand ignores comments inside aggregate pipelines", () => {
  const command = parseMongoAggregateCommand(`
    db.cash.aggregate([
      {
        $match: {
          portfolio_id: "b6f6ec62-8571-11f1-bbfb-000c29caf77f",
          date: { $gte: "20260604" }
        }
      },
      { $unwind: "$cashs" },
      {
        $project: {
          _id: 0,
          date: 1,
          trans_currency_cd: "$cashs.trans_currency_cd",
          cash_local: { $multiply: ["$cashs.cash", "$cashs.fx_rate"] }
        }
      },
      {
        $group: {
          _id: { date: "$date", currency: "$trans_currency_cd" },
          cash_local: { $sum: "$cash_local" }
        }
      },
      // 第二步：按 date 分组，将不同币种转为字段
      {
        $group: {
          _id: "$_id.date",
          cny: {
            $sum: {
              $cond: [{ $eq: ["$_id.currency", "CNY"] }, "$cash_local", 0]
            }
          },
          hkd: {
            $sum: {
              $cond: [{ $eq: ["$_id.currency", "HKD"] }, "$cash_local", 0]
            }
          },
          total_cash: { $sum: "$cash_local" }
        }
      },
      { $sort: { _id: 1 } },
      /* 可选：将 _id 重命名为 date */
      {
        $project: {
          _id: 0,
          date: "$_id",
          cny: 1,
          hkd: 1,
          total_cash: 1
        }
      }
    ])
  `);

  assert.ok(command);
  assert.equal(command.collection, "cash");
  const pipeline = JSON.parse(command.pipeline);
  assert.equal(pipeline.length, 7);
  assert.deepEqual(pipeline[4].$group.total_cash, { $sum: "$cash_local" });
});

test("parseMongoAggregateCommand keeps comment markers inside string values", () => {
  const command = parseMongoAggregateCommand(`db.logs.aggregate([
    { $match: { url: "https://example.com/a//b", note: "literal /* text */" } },
    // comment with closing delimiters )]}
    { $project: { url: 1, note: 1 } }
  ])`);

  assert.ok(command);
  assert.deepEqual(JSON.parse(command.pipeline)[0].$match, {
    url: "https://example.com/a//b",
    note: "literal /* text */",
  });
});

test("parseMongoAggregateCommand accepts every JavaScript line terminator after comments", () => {
  for (const lineTerminator of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
    const command = parseMongoAggregateCommand(`db.logs.aggregate([// pipeline${lineTerminator}{ $match: { active: true } }])`);

    assert.ok(command, `expected parser result for ${JSON.stringify(lineTerminator)}`);
    assert.deepEqual(JSON.parse(command.pipeline), [{ $match: { active: true } }]);
  }
});

test("parseMongoAggregateCommand accepts official aggregate options document", () => {
  assert.deepEqual(parseMongoAggregateCommand("db.products.aggregate([], {})"), {
    collection: "products",
    pipeline: "[]",
    options: "{}",
  });
  const withExplain = parseMongoAggregateCommand("db.uc_user.aggregate([], {explain: true})");
  assert.equal(withExplain?.collection, "uc_user");
  assert.equal(withExplain?.pipeline, "[]");
  assert.deepEqual(JSON.parse(withExplain?.options ?? "null"), { explain: true });

  // Official aggregate options are parsed as a free-form object and forwarded to the server.
  const fullOptions = parseMongoAggregateCommand(`db.products.aggregate(
    [{"$match":{"active":true}}],
    {
      allowDiskUse: true,
      cursor: { batchSize: 50 },
      maxTimeMS: 1000,
      collation: { locale: "en" },
      hint: "status_1",
      comment: "agg-test",
      let: { year: 2024 }
    }
  )`);
  assert.equal(fullOptions?.collection, "products");
  assert.deepEqual(JSON.parse(fullOptions?.pipeline ?? "null"), [{ $match: { active: true } }]);
  assert.deepEqual(JSON.parse(fullOptions?.options ?? "null"), {
    allowDiskUse: true,
    cursor: { batchSize: 50 },
    maxTimeMS: 1000,
    collation: { locale: "en" },
    hint: "status_1",
    comment: "agg-test",
    let: { year: 2024 },
  });
});

test("parseMongoAggregateCommand rejects non-array pipelines and invalid options", () => {
  assert.equal(parseMongoAggregateCommand('db.products.aggregate({"$match":{}})'), null);
  assert.equal(parseMongoAggregateCommand("db.products.aggregate([], [])"), null);
  assert.equal(parseMongoAggregateCommand("db.products.aggregate([], {explain: true"), null);
  assert.equal(parseMongoAggregateCommand("db.products.aggregate([]).limit(10)"), null);
  assert.equal(parseMongoAggregateCommand("db.products.aggregate([], {}, true)"), null);
});

test("describeMongoCommandParseFailure reports unclosed delimiters and shell hints", () => {
  const unclosed = describeMongoCommandParseFailure("db.uc_user.aggregate([], {explain: true");
  assert.match(unclosed, /unclosed/i);

  const chained = describeMongoCommandParseFailure("db.products.aggregate([]).limit(10)");
  assert.match(chained, /chaining|not supported/i);

  const nonArrayPipeline = describeMongoCommandParseFailure('db.products.aggregate({"$match":{}})');
  assert.match(nonArrayPipeline, /pipeline must be a JSON array/i);

  const badOptions = describeMongoCommandParseFailure("db.products.aggregate([], [])");
  assert.match(badOptions, /options must be a JSON object/i);

  const generic = describeMongoCommandParseFailure("SELECT 1");
  assert.match(generic, /MongoDB shell-style commands/i);
});

test("parseMongoAggregateCommand normalises ObjectId arguments with either quote style", () => {
  const oid = "507f1f77bcf86cd799439011";
  for (const quote of ['"', "'"]) {
    const command = parseMongoAggregateCommand(`db.orders.aggregate([{"$match":{"_id":ObjectId(${quote}${oid}${quote})}}])`);
    assert.ok(command, `quote=${quote} should parse`);
    assert.equal(command.collection, "orders");
    assert.deepEqual(JSON.parse(command.pipeline), [{ $match: { _id: { $oid: oid } } }]);
  }
});

test("parseMongoDistinctCommand parses a field with an optional filter", () => {
  assert.deepEqual(parseMongoDistinctCommand('db.products.distinct("category")'), {
    collection: "products",
    field: "category",
  });
  assert.deepEqual(parseMongoDistinctCommand("db.products.distinct('category', { active: true })"), {
    collection: "products",
    field: "category",
    filter: '{ "active": true }',
  });
  assert.deepEqual(parseMongoDistinctCommand('db.getCollection("audit.logs").distinct("level");'), {
    collection: "audit.logs",
    field: "level",
  });
});

test("parseMongoDistinctCommand normalises shell constructors in its filter", () => {
  const command = parseMongoDistinctCommand("db.orders.distinct(\"status\", { _id: ObjectId('507f1f77bcf86cd799439011') })");
  assert.ok(command);
  assert.deepEqual(JSON.parse(command.filter || "{}"), { _id: { $oid: "507f1f77bcf86cd799439011" } });
});

test("parseMongoDistinctCommand requires a non-empty string field", () => {
  assert.equal(parseMongoDistinctCommand("db.products.distinct()"), null);
  assert.equal(parseMongoDistinctCommand('db.products.distinct("")'), null);
  assert.equal(parseMongoDistinctCommand("db.products.distinct({ category: 1 })"), null);
  assert.equal(parseMongoDistinctCommand("db.products.distinct(category)"), null);
  // Cursor chaining and extra arguments are rejected rather than silently ignored.
  assert.equal(parseMongoDistinctCommand('db.products.distinct("category").limit(5)'), null);
  assert.equal(parseMongoDistinctCommand('db.products.distinct("category", {}, {})'), null);
});

test("parseMongoCommand tags distinct with its own kind", () => {
  assert.deepEqual(parseMongoCommand('db.products.distinct("category")')?.command, {
    kind: "distinct",
    collection: "products",
    field: "category",
  });
});

test("mongoDistinctToQueryResult names the column after the field", () => {
  assert.deepEqual(mongoDistinctToQueryResult("category", ["books", "toys", null], 4), {
    columns: ["category"],
    rows: [["books"], ["toys"], [null]],
    affected_rows: 3,
    execution_time_ms: 4,
  });
  // ObjectId values are displayed, not dumped as raw extended JSON.
  assert.deepEqual(mongoDistinctToQueryResult("owner", [{ $oid: "507f1f77bcf86cd799439011" }], 0).rows, [["507f1f77bcf86cd799439011"]]);
});

test("parseMongoGetIndexesCommand parses collection index commands", () => {
  assert.deepEqual(parseMongoGetIndexesCommand("db.web_log.getIndexes();"), {
    collection: "web_log",
  });
  assert.deepEqual(parseMongoGetIndexesCommand('db.getCollection("audit.logs").getIndexes()'), {
    collection: "audit.logs",
  });
  assert.equal(parseMongoGetIndexesCommand("db.web_log.getIndexes({})"), null);
});

test("parseMongoCollectionStatsCommand parses collection stats commands", () => {
  assert.deepEqual(parseMongoCollectionStatsCommand("db.users.stats()"), {
    collection: "users",
    metric: "stats",
  });
  assert.deepEqual(parseMongoCollectionStatsCommand("db.users.dataSize();"), {
    collection: "users",
    metric: "dataSize",
  });
  assert.deepEqual(parseMongoCollectionStatsCommand("db.users.storageSize(1024)"), {
    collection: "users",
    metric: "storageSize",
    scale: 1024,
  });
  assert.deepEqual(parseMongoCollectionStatsCommand("db.users.totalIndexSize()"), {
    collection: "users",
    metric: "totalIndexSize",
  });
  assert.deepEqual(parseMongoCollectionStatsCommand('db.getCollection("audit.logs").stats()'), {
    collection: "audit.logs",
    metric: "stats",
  });
  // A non-numeric argument is rejected rather than silently ignored.
  assert.equal(parseMongoCollectionStatsCommand('db.users.storageSize("big")'), null);
});

test("parseMongoCommand tags collection stats commands with the collectionStats kind", () => {
  const parsed = parseMongoCommand("db.users.stats()");
  assert.ok(parsed);
  assert.deepEqual(parsed.command, { kind: "collectionStats", collection: "users", metric: "stats" });
});

test("mongoCollectionStatsToQueryResult formats stats and single-metric results", () => {
  const stats = {
    count: 12,
    size: 4096,
    avgObjSize: 341,
    storageSize: 8192,
    totalIndexSize: 2048,
    nindexes: 3,
  };
  assert.deepEqual(mongoCollectionStatsToQueryResult("stats", stats, 5), {
    columns: ["count", "size", "avgObjSize", "storageSize", "totalIndexSize", "nindexes"],
    rows: [[12, 4096, 341, 8192, 2048, 3]],
    affected_rows: 1,
    execution_time_ms: 5,
  });
  assert.deepEqual(mongoCollectionStatsToQueryResult("dataSize", stats, 0), {
    columns: ["dataSize"],
    rows: [[4096]],
    affected_rows: 1,
    execution_time_ms: 0,
  });
  assert.deepEqual(mongoCollectionStatsToQueryResult("totalIndexSize", {}, 0), {
    columns: ["totalIndexSize"],
    rows: [[null]],
    affected_rows: 1,
    execution_time_ms: 0,
  });
});

test("splitMongoCommands keeps semicolon-separated mongo commands in order", () => {
  const commands = splitMongoCommands(`
    db.users.insertOne({ name: "A" });
    db.users.insertOne({ name: "B" });
  `);
  assert.deepEqual(
    commands.map(({ text, command }) => ({ kind: command.kind, text })),
    [
      { kind: "insert", text: 'db.users.insertOne({ name: "A" })' },
      { kind: "insert", text: 'db.users.insertOne({ name: "B" })' },
    ],
  );
});

test("splitMongoCommands splits top-level line starts without semicolons", () => {
  const commands = splitMongoCommands(`
    use accounting
    db.getCollection("entries")
      .find({ status: "open" })
      .limit(5)
  `);
  assert.deepEqual(
    commands.map(({ text, command }) => ({ kind: command.kind, text })),
    [
      { kind: "use", text: "use accounting" },
      { kind: "find", text: 'db.getCollection("entries")\n      .find({ status: "open" })\n      .limit(5)' },
    ],
  );
});

test("splitMongoCommandRanges preserve document offsets for newline-separated commands", () => {
  const source = `
    use accounting
    db.getCollection("entries")
      .find({ status: "open" })
      .limit(5)
  `;
  const commands = splitMongoCommandRanges(source);

  assert.deepEqual(
    commands.map(({ from, to, text, command }) => ({
      from,
      to,
      text,
      kind: command.kind,
    })),
    [
      {
        from: source.indexOf("use accounting"),
        to: source.indexOf("use accounting") + "use accounting".length,
        text: "use accounting",
        kind: "use",
      },
      {
        from: source.indexOf('db.getCollection("entries")'),
        to: source.indexOf("      .limit(5)") + "      .limit(5)".length,
        text: 'db.getCollection("entries")\n      .find({ status: "open" })\n      .limit(5)',
        kind: "find",
      },
    ],
  );
});

test("evaluateMongoAggregateSafety follows the DBX-managed MCP permission level", () => {
  const out = parseMongoAggregateCommand('db.products.aggregate([{"$out":"products_copy"}])');
  assert.ok(out);
  assert.equal(mongoAggregateWriteStage(out.pipeline), "$out");
  assert.match(evaluateMongoAggregateSafety(out, {}).reason || "", /DBX MCP read-only policy/i);

  const merge = parseMongoAggregateCommand('db.products.aggregate([{"$merge":{"into":"products_copy"}}])');
  assert.ok(merge);
  assert.equal(mongoAggregateWriteStage(merge.pipeline), "$merge");
  assert.match(evaluateMongoAggregateSafety(merge, { allowWrites: true }).reason || "", /high-risk operations.*DBX MCP settings/i);
  assert.equal(evaluateMongoAggregateSafety(merge, { allowWrites: true, allowDangerous: true }).allowed, true);
});

test("mongoIndexesToQueryResult formats index metadata", () => {
  assert.deepEqual(
    mongoIndexesToQueryResult(
      [
        {
          name: "_id_",
          columns: ["_id"],
          is_unique: false,
          is_primary: true,
          index_type: "_id: 1",
          filter: null,
        },
      ],
      7,
    ),
    {
      columns: ["name", "columns", "unique", "primary", "type", "filter"],
      rows: [["_id_", "_id", false, true, "_id: 1", null]],
      affected_rows: 1,
      execution_time_ms: 7,
    },
  );
});

test("mongoCountToQueryResult returns a single count row", () => {
  assert.deepEqual(mongoCountToQueryResult(42, 5), {
    columns: ["count"],
    rows: [[42]],
    affected_rows: 42,
    execution_time_ms: 5,
  });
});

test("mongoDocumentsToQueryResult turns mongo documents into grid rows", () => {
  const result = mongoDocumentsToQueryResult(
    [
      { _id: "1", name: "Ada", profile: { role: "admin" } },
      { _id: "2", active: true, name: "Lin" },
    ],
    5,
    12,
  );

  assert.deepEqual(result.columns, ["_id", "name", "profile", "active"]);
  assert.deepEqual(result.rows, [
    ["1", "Ada", '{"role":"admin"}', null],
    ["2", "Lin", null, true],
  ]);
  assert.deepEqual(result.mongo_documents, [
    { _id: "1", name: "Ada", profile: { role: "admin" } },
    { _id: "2", active: true, name: "Lin" },
  ]);
  assert.equal(result.affected_rows, 12);
  assert.equal(result.execution_time_ms, 5);
  assert.equal(result.truncated, true);
});

test("mongoDocumentsToQueryResult displays ids without losing raw type metadata", () => {
  const documents = [
    { _id: { $oid: "6743e4bfa3f6f84bc3fff6c8" }, name: "object id" },
    { _id: { $numberLong: "2048938405781032962" }, name: "int64" },
    { _id: 42, name: "int" },
    { _id: 42.5, name: "double" },
    { _id: "customer-42", name: "string" },
  ];
  const result = mongoDocumentsToQueryResult(documents, documents.length, documents.length);

  assert.deepEqual(result.rows, [
    ["6743e4bfa3f6f84bc3fff6c8", "object id"],
    ["2048938405781032962", "int64"],
    [42, "int"],
    [42.5, "double"],
    ["customer-42", "string"],
  ]);
  assert.deepEqual(result.mongo_documents, documents);
});

test("buildMongoUpdateDocument ignores _id and preserves typed values", () => {
  const changes = new Map<number, string | number | boolean | null>([
    [0, "other-id"],
    [1, "42"],
    [2, '{"role":"admin"}'],
    [3, null],
  ]);

  const update = buildMongoDocumentUpdate(changes, ["_id", "age", "profile", "nickname"]);

  assert.deepEqual(update, {
    $set: {
      age: 42,
      profile: { role: "admin" },
    },
    $unset: {
      nickname: "",
    },
  });
  assert.equal(formatMongoDocumentShellLiteral(update), '{"$set":{"age":42,"profile":{"role":"admin"}},"$unset":{"nickname":""}}');
});
