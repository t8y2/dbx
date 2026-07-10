import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  evaluateMongoAggregateSafety,
  evaluateMongoWriteSafety,
  mongoAggregateWriteStage,
  mongoCollectionStatsToQueryResult,
  mongoCountToQueryResult,
  mongoDocumentsToQueryResult,
  mongoIndexesToQueryResult,
  parseMongoAggregateCommand,
  parseMongoCollectionStatsCommand,
  parseMongoCommand,
  parseMongoCountDocumentsCommand,
  parseMongoFindCommand,
  parseMongoGetIndexesCommand,
  parseMongoVersionCommand,
  parseMongoWriteCommand,
  splitMongoCommands,
  splitMongoCommandRanges,
} from "../../apps/desktop/src/lib/mongo/mongoShellCommand.ts";
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
  assert.match(evaluateMongoWriteSafety(dropCollection, { allowWrites: true }).reason || "", /DBX_MCP_ALLOW_DANGEROUS_SQL=1/);
  assert.equal(evaluateMongoWriteSafety(dropCollection, { allowWrites: true, allowDangerous: true }).allowed, true);
});

test("evaluateMongoWriteSafety blocks dangerous dropIndexes shapes unless enabled", () => {
  const dropAll = parseMongoWriteCommand("db.users.dropIndexes()");
  assert.ok(dropAll);
  assert.match(evaluateMongoWriteSafety(dropAll, { allowWrites: true }).reason || "", /DBX_MCP_ALLOW_DANGEROUS_SQL=1/);

  const dropOne = parseMongoWriteCommand('db.users.dropIndexes("users_email_unique")');
  assert.ok(dropOne);
  assert.equal(evaluateMongoWriteSafety(dropOne, { allowWrites: true }).allowed, true);
});

test("parseMongoCountDocumentsCommand parses db collection countDocuments", () => {
  assert.deepEqual(parseMongoCountDocumentsCommand("db.products.countDocuments({})"), {
    collection: "products",
    filter: "{}",
  });
});

test("parseMongoCountDocumentsCommand parses legacy count helpers", () => {
  assert.deepEqual(parseMongoCountDocumentsCommand("db.products.count({ active: true })"), {
    collection: "products",
    filter: '{ "active": true }',
  });
  assert.deepEqual(parseMongoCountDocumentsCommand('db.getCollection("audit.logs").count()'), {
    collection: "audit.logs",
    filter: "{}",
  });
  assert.deepEqual(parseMongoCountDocumentsCommand("db.products.find({ active: true }).count()"), {
    collection: "products",
    filter: '{ "active": true }',
  });
  assert.equal(parseMongoFindCommand("db.products.find({ active: true }).count()"), null);
  assert.deepEqual(parseMongoCommand("db.products.find({ active: true }).count()")?.command, {
    kind: "countDocuments",
    collection: "products",
    filter: '{ "active": true }',
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

test("parseMongoAggregateCommand rejects non-array pipelines and extra arguments", () => {
  assert.equal(parseMongoAggregateCommand('db.products.aggregate({"$match":{}})'), null);
  assert.equal(parseMongoAggregateCommand("db.products.aggregate([], {})"), null);
  assert.equal(parseMongoAggregateCommand("db.products.aggregate([]).limit(10)"), null);
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
        to: source.indexOf('      .limit(5)') + "      .limit(5)".length,
        text: 'db.getCollection("entries")\n      .find({ status: "open" })\n      .limit(5)',
        kind: "find",
      },
    ],
  );
});

test("evaluateMongoAggregateSafety blocks write stages unless MCP write flags allow them", () => {
  const out = parseMongoAggregateCommand('db.products.aggregate([{"$out":"products_copy"}])');
  assert.ok(out);
  assert.equal(mongoAggregateWriteStage(out.pipeline), "$out");
  assert.match(evaluateMongoAggregateSafety(out, {}).reason || "", /DBX_MCP_ALLOW_WRITES=1/);

  const merge = parseMongoAggregateCommand('db.products.aggregate([{"$merge":{"into":"products_copy"}}])');
  assert.ok(merge);
  assert.equal(mongoAggregateWriteStage(merge.pipeline), "$merge");
  assert.match(evaluateMongoAggregateSafety(merge, { allowWrites: true }).reason || "", /DBX_MCP_ALLOW_DANGEROUS_SQL=1/);
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
  assert.equal(result.affected_rows, 12);
  assert.equal(result.execution_time_ms, 5);
  assert.equal(result.truncated, true);
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
