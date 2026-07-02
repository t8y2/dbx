import assert from "node:assert/strict";
import { test } from "vitest";
import { executeQuery, inferMongoColumns, mongoAggregateWriteStage, mongoDocumentsToQueryResult, parseMongoAggregateCommand, parseMongoCountDocumentsCommand, parseMongoFindCommand, parseMongoGetIndexesCommand, parseMongoVersionCommand, parseMongoWriteCommand } from "../src/database.js";

test("parseMongoFindCommand accepts shell-style find commands", () => {
  assert.deepEqual(parseMongoFindCommand('db.getCollection("operation_logs").find({"level":"info"}).sort({"ts":-1}).skip(5).limit(10)'), {
    collection: "operation_logs",
    filter: '{"level":"info"}',
    skip: 5,
    limit: 10,
    sort: '{"ts":-1}',
  });
});

test("parseMongoFindCommand accepts line breaks before find and chained calls", () => {
  const command = parseMongoFindCommand(`db.getCollection("operation_logs")
.find({
  "_id": ObjectId("68ad51ca84c8127bc7d44cb3")
})
.sort({ ts: -1 })
.skip(5)
.limit(10)`);
  assert.ok(command);
  assert.equal(command.collection, "operation_logs");
  assert.deepEqual(JSON.parse(command.filter), { _id: { $oid: "68ad51ca84c8127bc7d44cb3" } });
  assert.deepEqual(JSON.parse(command.sort || "{}"), { ts: -1 });
  assert.equal(command.skip, 5);
  assert.equal(command.limit, 10);
});

test("parseMongoFindCommand accepts Compass-style unquoted keys and ObjectId", () => {
  const command = parseMongoFindCommand("db.products.find({_id: ObjectId('6a045a92d2971e44243771a1')}).limit(1)");
  assert.ok(command);
  assert.equal(command.collection, "products");
  assert.equal(command.limit, 1);
  assert.deepEqual(JSON.parse(command.filter), { _id: { $oid: "6a045a92d2971e44243771a1" } });
});

test("parseMongoFindCommand accepts projection arguments", () => {
  const command = parseMongoFindCommand("db.jobs.find({status: 'open'}, {title: 1, _id: 0}).sort({title: 1})");
  assert.ok(command);
  assert.equal(command.collection, "jobs");
  assert.deepEqual(JSON.parse(command.filter), { status: "open" });
  assert.deepEqual(JSON.parse(command.projection || "{}"), { title: 1, _id: 0 });
  assert.deepEqual(JSON.parse(command.sort || "{}"), { title: 1 });
});

test("parseMongoVersionCommand accepts db.version", () => {
  assert.equal(parseMongoVersionCommand("db.version();"), true);
  assert.equal(parseMongoVersionCommand("db.jobs.version()"), false);
});

test("parseMongoWriteCommand accepts unquoted update operator keys", () => {
  assert.deepEqual(parseMongoWriteCommand("db.projects.updateOne({_id: ObjectId('507f1f77bcf86cd799439011')}, {$set: {name: 'next'}})"), {
    kind: "update",
    collection: "projects",
    filter: '{"_id": {"$oid":"507f1f77bcf86cd799439011"}}',
    update: '{"$set": {"name": "next"}}',
    many: false,
  });
});

test("parseMongoCountDocumentsCommand accepts shell-style count commands", () => {
  assert.deepEqual(parseMongoCountDocumentsCommand('db.projects.countDocuments({"active":true})'), {
    collection: "projects",
    filter: '{"active":true}',
  });
});

test("parseMongoAggregateCommand accepts aggregate pipelines", () => {
  assert.deepEqual(parseMongoAggregateCommand('db.projects.aggregate([{"$match":{"active":true}},{"$group":{"_id":"$owner","total":{"$sum":1}}}])'), {
    collection: "projects",
    pipeline: '[{"$match":{"active":true}},{"$group":{"_id":"$owner","total":{"$sum":1}}}]',
  });
});

test("parseMongoGetIndexesCommand accepts shell-style index commands", () => {
  assert.deepEqual(parseMongoGetIndexesCommand("db.web_log.getIndexes();"), {
    collection: "web_log",
  });
  assert.deepEqual(parseMongoGetIndexesCommand('db.getCollection("audit.logs").getIndexes()'), {
    collection: "audit.logs",
  });
  assert.equal(parseMongoGetIndexesCommand("db.web_log.getIndexes({})"), null);
});

test("mongoAggregateWriteStage detects write stages", () => {
  assert.equal(mongoAggregateWriteStage('[{"$match":{"active":true}}]'), null);
  assert.equal(mongoAggregateWriteStage('[{"$match":{}},{"$out":"projects_dump"}]'), "$out");
  assert.equal(mongoAggregateWriteStage('[{"$merge":{"into":"projects_dump"}}]'), "$merge");
});

test("mongodb executeQuery blocks aggregate write stages until dangerous SQL is enabled", async () => {
  const oldAllowWrites = process.env.DBX_MCP_ALLOW_WRITES;
  const oldAllowDangerous = process.env.DBX_MCP_ALLOW_DANGEROUS_SQL;
  delete process.env.DBX_MCP_ALLOW_WRITES;
  delete process.env.DBX_MCP_ALLOW_DANGEROUS_SQL;
  const config = {
    id: "mongo",
    name: "mongo",
    db_type: "mongodb",
    host: "127.0.0.1",
    port: 27017,
    username: "",
    password: "",
    database: "app",
    ssh_enabled: false,
    ssl: false,
  } as const;

  await assert.rejects(executeQuery(config, 'db.projects.aggregate([{"$merge":{"into":"projects_dump"}}])'), /DBX_MCP_ALLOW_DANGEROUS_SQL=1/);

  if (oldAllowWrites === undefined) delete process.env.DBX_MCP_ALLOW_WRITES;
  else process.env.DBX_MCP_ALLOW_WRITES = oldAllowWrites;
  if (oldAllowDangerous === undefined) delete process.env.DBX_MCP_ALLOW_DANGEROUS_SQL;
  else process.env.DBX_MCP_ALLOW_DANGEROUS_SQL = oldAllowDangerous;
});

test("parseMongoWriteCommand accepts supported write commands", () => {
  assert.deepEqual(parseMongoWriteCommand('db.projects.insertOne({"name":"demo"})'), {
    kind: "insert",
    collection: "projects",
    docsJson: '{"name":"demo"}',
  });
  assert.deepEqual(parseMongoWriteCommand('db.projects.updateOne({"_id":"1"},{"$set":{"name":"next"}})'), {
    kind: "update",
    collection: "projects",
    filter: '{"_id":"1"}',
    update: '{"$set":{"name":"next"}}',
    many: false,
  });
  assert.deepEqual(parseMongoWriteCommand('db.projects.deleteMany({"stale":true})'), {
    kind: "delete",
    collection: "projects",
    filter: '{"stale":true}',
    many: true,
  });
  assert.deepEqual(parseMongoWriteCommand('db.projects.createIndex({"email":1},{"unique":true,"name":"projects_email_unique"})'), {
    kind: "createIndex",
    collection: "projects",
    keys: '{"email":1}',
    options: '{"unique":true,"name":"projects_email_unique"}',
  });
  assert.deepEqual(parseMongoWriteCommand('db.projects.dropIndex("projects_email_unique")'), {
    kind: "dropIndex",
    collection: "projects",
    index: '"projects_email_unique"',
  });
  assert.deepEqual(parseMongoWriteCommand("db.projects.dropIndexes()"), {
    kind: "dropIndexes",
    collection: "projects",
  });
  assert.deepEqual(parseMongoWriteCommand('db.projects.dropIndexes({"email":1})'), {
    kind: "dropIndexes",
    collection: "projects",
    indexes: '{"email":1}',
  });
  assert.deepEqual(parseMongoWriteCommand('db.projects.dropIndexes(["a_1","b_1"])'), {
    kind: "dropIndexes",
    collection: "projects",
    indexes: '["a_1","b_1"]',
  });
});

test("parseMongoWriteCommand rejects invalid dropIndex and dropIndexes commands", () => {
  assert.equal(parseMongoWriteCommand("db.projects.dropIndex()"), null);
  assert.equal(parseMongoWriteCommand('db.projects.dropIndex("*")'), null);
  assert.equal(parseMongoWriteCommand('db.projects.dropIndex(["a_1"])'), null);
  assert.equal(parseMongoWriteCommand('db.projects.dropIndexes([{"email":1}])'), null);
});

test("mongodb executeQuery blocks writes when writes are explicitly disabled", async () => {
  const oldAllowWrites = process.env.DBX_MCP_ALLOW_WRITES;
  process.env.DBX_MCP_ALLOW_WRITES = "0";
  await assert.rejects(
    executeQuery(
      {
        id: "mongo",
        name: "mongo",
        db_type: "mongodb",
        host: "127.0.0.1",
        port: 27017,
        username: "",
        password: "",
        database: "app",
        ssh_enabled: false,
        ssl: false,
      },
      'db.projects.insertOne({"name":"demo"})',
    ),
    /read-only/i,
  );
  if (oldAllowWrites === undefined) delete process.env.DBX_MCP_ALLOW_WRITES;
  else process.env.DBX_MCP_ALLOW_WRITES = oldAllowWrites;
});

test("mongodb executeQuery treats createIndex as a write when writes are explicitly disabled", async () => {
  const oldAllowWrites = process.env.DBX_MCP_ALLOW_WRITES;
  process.env.DBX_MCP_ALLOW_WRITES = "0";
  await assert.rejects(
    executeQuery(
      {
        id: "mongo",
        name: "mongo",
        db_type: "mongodb",
        host: "127.0.0.1",
        port: 27017,
        username: "",
        password: "",
        database: "app",
        ssh_enabled: false,
        ssl: false,
      },
      'db.projects.createIndex({"email":1})',
    ),
    /read-only/i,
  );
  if (oldAllowWrites === undefined) delete process.env.DBX_MCP_ALLOW_WRITES;
  else process.env.DBX_MCP_ALLOW_WRITES = oldAllowWrites;
});

test("mongodb executeQuery treats dropIndex as a write when writes are explicitly disabled", async () => {
  const oldAllowWrites = process.env.DBX_MCP_ALLOW_WRITES;
  process.env.DBX_MCP_ALLOW_WRITES = "0";
  await assert.rejects(
    executeQuery(
      {
        id: "mongo",
        name: "mongo",
        db_type: "mongodb",
        host: "127.0.0.1",
        port: 27017,
        username: "",
        password: "",
        database: "app",
        ssh_enabled: false,
        ssl: false,
      },
      'db.projects.dropIndex("projects_email_unique")',
    ),
    /read-only/i,
  );
  if (oldAllowWrites === undefined) delete process.env.DBX_MCP_ALLOW_WRITES;
  else process.env.DBX_MCP_ALLOW_WRITES = oldAllowWrites;
});

test("mongodb executeQuery blocks dangerous dropIndexes shapes until dangerous SQL is enabled", async () => {
  const oldAllowWrites = process.env.DBX_MCP_ALLOW_WRITES;
  const oldAllowDangerous = process.env.DBX_MCP_ALLOW_DANGEROUS_SQL;
  process.env.DBX_MCP_ALLOW_WRITES = "1";
  delete process.env.DBX_MCP_ALLOW_DANGEROUS_SQL;

  const config = {
    id: "mongo",
    name: "mongo",
    db_type: "mongodb",
    host: "127.0.0.1",
    port: 27017,
    username: "",
    password: "",
    database: "app",
    ssh_enabled: false,
    ssl: false,
  } as const;

  await assert.rejects(executeQuery(config, "db.projects.dropIndexes()"), /DBX_MCP_ALLOW_DANGEROUS_SQL=1/);
  await assert.rejects(executeQuery(config, 'db.projects.dropIndexes("*")'), /DBX_MCP_ALLOW_DANGEROUS_SQL=1/);
  await assert.rejects(executeQuery(config, 'db.projects.dropIndexes(["a_1","b_1"])'), /DBX_MCP_ALLOW_DANGEROUS_SQL=1/);

  if (oldAllowWrites === undefined) delete process.env.DBX_MCP_ALLOW_WRITES;
  else process.env.DBX_MCP_ALLOW_WRITES = oldAllowWrites;
  if (oldAllowDangerous === undefined) delete process.env.DBX_MCP_ALLOW_DANGEROUS_SQL;
  else process.env.DBX_MCP_ALLOW_DANGEROUS_SQL = oldAllowDangerous;
});

test("mongoDocumentsToQueryResult turns documents into rows", () => {
  assert.deepEqual(
    mongoDocumentsToQueryResult(
      [
        { _id: "1", nested: { ok: true } },
        { _id: "2", name: "demo" },
      ],
      2,
    ),
    {
      columns: ["_id", "nested", "name"],
      rows: [
        { _id: "1", nested: '{"ok":true}', name: undefined },
        { _id: "2", nested: undefined, name: "demo" },
      ],
      row_count: 2,
    },
  );
});

test("inferMongoColumns marks _id as primary and reports observed types", () => {
  assert.deepEqual(
    inferMongoColumns([
      { _id: "1", active: true },
      { _id: "2", active: null },
    ]),
    [
      {
        name: "_id",
        data_type: "string",
        is_nullable: false,
        column_default: null,
        is_primary_key: true,
        comment: null,
      },
      {
        name: "active",
        data_type: "boolean | null",
        is_nullable: true,
        column_default: null,
        is_primary_key: false,
        comment: null,
      },
    ],
  );
});
