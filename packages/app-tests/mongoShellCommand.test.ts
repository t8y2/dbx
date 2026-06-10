import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  evaluateMongoAggregateSafety,
  mongoAggregateWriteStage,
  mongoCountToQueryResult,
  mongoDocumentsToQueryResult,
  mongoIndexesToQueryResult,
  parseMongoAggregateCommand,
  parseMongoCountDocumentsCommand,
  parseMongoFindCommand,
  parseMongoGetIndexesCommand,
  parseMongoWriteCommand,
} from "../../apps/desktop/src/lib/mongoShellCommand.ts";

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

test("parseMongoFindCommand accepts Compass-style unquoted keys and ObjectId", () => {
  const command = parseMongoFindCommand("db.products.find({_id: ObjectId('6a045a92d2971e44243771a1')}).limit(1)");
  assert.ok(command);
  assert.equal(command.collection, "products");
  assert.equal(command.limit, 1);
  assert.deepEqual(JSON.parse(command.filter), { _id: { $oid: "6a045a92d2971e44243771a1" } });
});

test("parseMongoFindCommand accepts single-quoted string values and unquoted sort keys", () => {
  const command = parseMongoFindCommand("db.products.find({category: 'Electronics'}).sort({price: -1}).limit(2)");
  assert.ok(command);
  assert.equal(command.collection, "products");
  assert.equal(command.limit, 2);
  assert.deepEqual(JSON.parse(command.filter), { category: "Electronics" });
  assert.deepEqual(JSON.parse(command.sort || "{}"), { price: -1 });
});

test("parseMongoFindCommand rejects unsupported mongo shell commands", () => {
  assert.equal(parseMongoFindCommand("db.users.drop()"), null);
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

test("parseMongoCountDocumentsCommand parses db collection countDocuments", () => {
  assert.deepEqual(parseMongoCountDocumentsCommand("db.products.countDocuments({})"), {
    collection: "products",
    filter: "{}",
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
