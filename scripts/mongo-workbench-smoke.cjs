// In-process smoke checks: no child processes, network or user databases.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(specifier, parent, ...args) {
  if (specifier.startsWith("@/")) specifier = path.join(root, "apps/desktop/src", specifier.slice(2));
  return originalResolve.call(this, specifier, parent, ...args);
};
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true } });
  module._compile(result.outputText, filename);
};
const load = (name) => require(path.join(root, "apps/desktop/src/lib/mongo", name + ".ts"));
const tests = [];
function test(name, run) { tests.push({ name, run }); }
const agg = load("mongoAggregation");
const sql = load("mongoSql");
const transform = load("mongoTransform");
const compare = load("mongoCompare");
const runtime = load("mongoCompareRuntime");
const schema = load("mongoSchemaAnalysis");
const protocol = load("mongoScriptProtocol");
test("JSON input rejects unsafe numbers without damaging canonical BSON", () => {
  const { parseMongoJson } = load("mongoJson");
  for (const value of ['{"n":9007199254740993}', '[1e999]', '[-0]']) assert.throws(() => parseMongoJson(value));
  assert.deepEqual(parseMongoJson('{"n":{"$numberLong":"9223372036854775807"}}'), { n: { $numberLong: "9223372036854775807" } });
});
test("pipeline output guard and BSON code generation", () => {
  assert.deepEqual(agg.mongoPipelinePreview([{ $match: {} }, { $merge: { into: { db: "target", coll: "out" } } }], "source"), [{ $match: {} }]);
  assert.throws(() => agg.mongoPipelineOutput([{ $facet: { branch: [{ $out: "bad" }] } }], "db"));
  assert.throws(() => agg.parseMongoPipeline('[{"$match":{},"$sort":{}}]'));
  for (const language of ["mongosh", "node"]) assert.match(agg.mongoPipelineCode(language, "db", "col", []), /relaxed: false/);
  for (const language of ["mongosh", "node", "python", "java", "csharp"]) {
    const code = agg.mongoPipelineCode(language, "db", "col", [{ $match: { text: "line\u2028next\u2029line" } }]);
    assert.ok(!code.includes("\u2028") && !code.includes("\u2029"));
  }
  assert.ok(agg.mongoPipelineCode("java", "db", "col", [{ $match: { text: "汉".repeat(30000) } }]).includes('BsonArray.parse(String.join("", '));
});
test("schema nested array paths and BSON scalar counts", () => {
  const result = schema.analyzeMongoSchema([{ _id: { $oid: "507f1f77bcf86cd799439011" }, items: [{ sku: "a" }, { sku: "b" }] }, { items: [] }]);
  const item = result.fields.find(field => field.path === '$["items"][]["sku"]');
  assert.equal(item.documents, 1); assert.equal(item.occurrences, 2); assert.equal(item.missing, 1);
  assert.deepEqual(result.fields.find(field => field.path === '$["_id"]').types, { objectId: 1 });
});
test("masking preserves input and _id, handles nested arrays and hashes", async () => {
  const input = [{ _id: 1, items: [{ email: "a" }, { email: "a" }], city: "Paris" }];
  const result = await transform.transformMongoDocuments(input, [{ path: "items.*.email", action: "hash" }, { path: "city", action: "rename", destination: "address.city" }], { secret: "smoke-test-secret-123" });
  assert.equal(result[0].items[0].email, result[0].items[1].email);
  assert.match(result[0].items[0].email, /^[a-f0-9]{64}$/);
  assert.equal(result[0].address.city, "Paris"); assert.equal(input[0].city, "Paris");
  for (const field of ["_id", "*", "__proto__.x", "a.constructor"]) assert.throws(() => transform.validateMongoTransformRules([{ path: field, action: "remove" }]));
});
test("SQL SELECT, JOIN, groups, pagination and rejection", () => {
  assert.deepEqual(sql.compileMongoSql("SELECT * FROM people LIMIT 0").pipeline, [{ $match: { $expr: false } }]);
  const result = sql.compileMongoSql("SELECT c.name AS customer, SUM(o.total) AS amount FROM orders o LEFT JOIN customers c ON o.customerId = c._id GROUP BY c.name ORDER BY amount DESC LIMIT 20 OFFSET 10");
  assert.equal(result.pipeline[1].$lookup.let.local, "$__dbx_source.customerId");
  assert.deepEqual(result.pipeline.slice(-3), [{ $sort: { amount: -1 } }, { $skip: 10 }, { $limit: 20 }]);
  assert.deepEqual(result.pipeline[4].$project.amount, { $cond: [{ $gt: ["$n1", 0] }, "$a1", null] });
  assert.ok(JSON.stringify(sql.compileMongoSql("SELECT name FROM people WHERE name = '$password'").pipeline).includes('"$literal":"$password"'));
  for (const text of ["DELETE FROM a", "SELECT * FROM a; DROP TABLE a", "SELECT x+1 FROM a", "SELECT x, COUNT(*) FROM a", "SELECT x FROM a LIMIT 1.5", "SELECT x FROM a WHERE x=9007199254740993"]) assert.throws(() => sql.compileMongoSql(text), text);
});
test("sync cancellation stops remaining writes", async () => {
  const source = { connectionId: "source", database: "db", collection: "col", filter: "{}" };
  const target = { ...source, connectionId: "target" };
  const docs = [{ _id: 1 }, { _id: 2 }];
  const changes = compare.compareMongoDocuments(docs, [], { matchFields: ["_id"] }).rows.map(row => compare.planMongoSync(row, "target"));
  const controller = new AbortController(); let written = 0;
  const api = {
    async mongoFindDocuments(id, _db, _col, _skip, _limit, filter) {
      const key = JSON.parse(filter).$expr.$and[0].$eq[1].$literal;
      const values = id === "source" ? docs.filter(doc => doc._id === key) : [];
      return { documents: values, extended_documents: values };
    },
    async mongoRunCommand() { written++; controller.abort(); return { documents: [{ ok: 1, n: 1 }] }; },
  };
  await assert.rejects(runtime.executeMongoSync(api, source, target, ["_id"], changes, undefined, controller.signal), error => error.code === "cancelled");
  assert.equal(written, 1);
});
test("script protocol allows only scoped methods and identifies output writes", () => {
  assert.equal(protocol.mongoScriptOperation({ id: 1, collection: "col", method: "aggregate", args: [[{ $out: "dest" }]] }, "db").operation.kind, "write");
  assert.throws(() => protocol.mongoScriptOperation({ id: 1, collection: "col", method: "runCommand", args: [{ dropDatabase: 1 }] }, "db"));
  assert.throws(() => protocol.mongoScriptOperation({ id: 1, collection: "col", method: "find", args: [{}, {}, { limit: 0 }] }, "db"));
  for (const value of [undefined, NaN, Infinity, 9007199254740992, new Date(), /x/, new Map(), new Set(), { get n() { return 1; } }])
    assert.throws(() => protocol.mongoScriptOperation({ id: 1, collection: "col", method: "insertOne", args: [{ value }] }, "db"));
  for (const projection of [{ a: { $slice: 2 } }, { a: 1, b: 0 }, { "a.$": 1 }])
    assert.throws(() => protocol.mongoScriptOperation({ id: 1, collection: "col", method: "find", args: [{}, projection] }, "db"));
});
test("script worker runs functions, loops, awaits and typed helpers", async () => {
  const source = fs.readFileSync(path.join(root, "apps/desktop/src/lib/mongo/mongoScriptWorker.js"), "utf8");
  const messages = []; let context;
  let done;
  const completion = new Promise(resolve => { done = resolve; });
  context = vm.createContext({ postMessage(message) {
    messages.push(message);
    if (message.type === "rpc") queueMicrotask(() => context.self.onmessage({ data: { type: "response", id: message.request.id, value: [{ n: 3 }, { n: 4 }] } }));
    if (message.type === "done" || message.type === "error") done(message);
  } });
  context.self = context;
  vm.runInContext(source, context);
  await context.self.onmessage({ data: { type: "start", source: 'function twice(n) { return n*2; } const docs = await db.items.find({}).toArray(); let total=0; for(const doc of docs) total+=twice(doc.n); print(total, NumberLong("9223372036854775807"));' } });
  const terminal = await completion;
  assert.equal(terminal.type, "done", terminal.message);
  const log = messages.find(message => message.type === "log");
  assert.equal(log.values[0], 14); assert.equal(log.values[1].$numberLong, "9223372036854775807");
});
test("Vue workbench components parse and compile templates", () => {
  const compiler = require("vue/compiler-sfc");
  const directory = path.join(root, "apps/desktop/src/components/mongo");
  for (const filename of fs.readdirSync(directory).filter(name => name.endsWith(".vue"))) {
    const source = fs.readFileSync(path.join(directory, filename), "utf8");
    const result = compiler.parse(source, { filename }); assert.deepEqual(result.errors, [], filename);
    const script = compiler.compileScript(result.descriptor, { id: filename });
    const template = compiler.compileTemplate({ source: result.descriptor.template.content, filename, id: filename, compilerOptions: { bindingMetadata: script.bindings } });
    assert.deepEqual(template.errors, [], filename);
  }
});
require("./mongo-migration-smoke.cjs")(test, assert, load);
require("./mongo-script-sandbox-smoke.cjs")(test, assert, load);
(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log("PASS " + name); }
    catch (error) { failed++; console.error("FAIL " + name, error); }
  }
  console.log((tests.length - failed) + "/" + tests.length + " smoke checks passed");
  process.exitCode = failed ? 1 : 0;
})();
