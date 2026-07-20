import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildMongoCompletionItems, getMongoCompletionContext, inferMongoCompletionFields, shouldAutoOpenMongoCompletion } from "../../apps/desktop/src/lib/mongo/mongoCompletion.ts";
import { ACCUMULATORS, EXPRESSION_OPERATORS, PIPELINE_STAGES, PUSH_MODIFIERS, QUERY_OPERATORS, STAGE_OPTION_KEYS, UPDATE_OPERATORS, VALUE_SNIPPETS } from "../../apps/desktop/src/lib/mongo/mongoCompletionTables.ts";

const collections = ["users", "user_events", "order-items", "audit.logs"];
const fields = [
  { name: "_id", type: "object" },
  { name: "name", type: "string" },
  { name: "profile.email", type: "string" },
  { name: "createdAt", type: "string" },
];

function labels(text: string, input = {}) {
  return buildMongoCompletionItems(text, text.length, input).map((item) => item.label);
}

test("suggests MongoDB root snippets and methods", () => {
  const items = buildMongoCompletionItems("fi", 2);

  assert.ok(items.some((item) => item.type === "function" && item.label === "find" && item.apply === "find({})"));
  assert.equal(
    items.some((item) => item.label === "SELECT"),
    false,
  );
});

test("suggests collections after db dot", () => {
  const items = buildMongoCompletionItems("db.us", "db.us".length, { collections });

  assert.deepEqual(
    items.filter((item) => item.type === "table" && item.detail === "collection").map((item) => item.label),
    ["users", "user_events"],
  );
});

test("uses getCollection apply text for unsafe collection names", () => {
  const item = buildMongoCompletionItems("db.order", "db.order".length, { collections }).find((candidate) => candidate.label === "order-items");

  assert.equal(item?.apply, 'getCollection("order-items")');
});

test("continues dotted collection names after a direct db prefix", () => {
  const items = buildMongoCompletionItems("db.audit.", "db.audit.".length, { collections });
  const dottedCollection = items.find((candidate) => candidate.label === "audit.logs");

  assert.equal(dottedCollection?.apply, 'getCollection("audit.logs")');
  assert.equal(getMongoCompletionContext("db.audit.", "db.audit.".length).from, "db.".length);
});

test("keeps direct collection method completion while resolving dotted names", () => {
  const item = buildMongoCompletionItems("db.users.fi", "db.users.fi".length, { collections }).find((candidate) => candidate.label === "find");

  assert.equal(item?.apply, "users.find({})");
});

test("suggests dotted names inside getCollection", () => {
  const text = 'db.getCollection("audit.';
  const item = buildMongoCompletionItems(text, text.length, { collections }).find((candidate) => candidate.label === "audit.logs");

  assert.equal(item?.apply, '"audit.logs"');
});

test("suggests collection methods after direct and getCollection references", () => {
  assert.ok(labels("db.users.").includes("find"));
  assert.ok(labels('db.getCollection("users").ag').includes("aggregate"));
});

test("suggests collection stats methods after a collection reference", () => {
  const methodLabels = labels("db.users.");
  for (const method of ["stats", "dataSize", "storageSize", "totalIndexSize"]) {
    assert.ok(methodLabels.includes(method), `expected completion to include ${method}`);
  }
  const item = buildMongoCompletionItems("db.users.stat", "db.users.stat".length).find((candidate) => candidate.label === "stats");
  assert.equal(item?.apply, "users.stats()");
});

test("suggests cursor methods after find result chains", () => {
  const allItems = buildMongoCompletionItems("db.characters.find({}).", "db.characters.find({}).".length);
  const prefixedItems = buildMongoCompletionItems("db.characters.find({}).li", "db.characters.find({}).li".length);
  const formattedChainItems = buildMongoCompletionItems("db.characters.find({\n  name: 'Ada'\n})\n  .", "db.characters.find({\n  name: 'Ada'\n})\n  .".length);
  const formattedPrefixedItems = buildMongoCompletionItems("db.characters.find({\n  name: 'Ada'\n})\n  .li", "db.characters.find({\n  name: 'Ada'\n})\n  .li".length);

  assert.deepEqual(
    allItems.map((item) => item.label),
    ["limit", "count", "skip", "sort"],
  );
  assert.deepEqual(
    prefixedItems.map((item) => item.label),
    ["limit"],
  );
  assert.deepEqual(
    formattedChainItems.map((item) => item.label),
    ["limit", "count", "skip", "sort"],
  );
  assert.deepEqual(
    formattedPrefixedItems.map((item) => item.label),
    ["limit"],
  );
});

test("offers count only where find().count() actually parses", () => {
  // The shell parser accepts count() only as the sole call chained onto find().
  assert.ok(labels("db.characters.find({}).").includes("count"));
  assert.equal(labels("db.characters.find({}).sort({ name: 1 }).").includes("count"), false);
  assert.equal(labels("db.characters.aggregate([]).").includes("count"), false);
});

test("suggests observed fields inside query objects", () => {
  const items = buildMongoCompletionItems('db.users.find({ "pro', 'db.users.find({ "pro'.length, { fields });
  const email = items.find((item) => item.label === "profile.email");

  assert.equal(email?.detail, "observed field · string");
  assert.equal(email?.type, "column");
  assert.equal(email?.apply, '"profile.email": ');
});

test("suggests query fields at object starts and after commas", () => {
  const objectStart = buildMongoCompletionItems("db.users.find({", "db.users.find({".length, { fields });
  const afterComma = buildMongoCompletionItems("db.users.find({ name: 'Ada', ", "db.users.find({ name: 'Ada', ".length, { fields });

  assert.ok(objectStart.find((item) => item.label === "name" && item.apply === "name: "));
  assert.ok(afterComma.find((item) => item.label === "createdAt" && item.apply === "createdAt: "));
});

test("suggests query operators inside field value objects", () => {
  const items = buildMongoCompletionItems("db.users.find({ age: { ", "db.users.find({ age: { ".length, { fields });

  assert.ok(items.find((item) => item.label === "$gte"));
  assert.equal(
    items.some((item) => item.label === "name"),
    false,
  );
});

test("suggests query and update operators", () => {
  assert.ok(labels("db.users.find({ age: { $g").includes("$gte"));
  assert.ok(labels("db.users.updateOne({}, { $s").includes("$set"));
});

test("suggests aggregation stages inside aggregate pipeline", () => {
  const items = buildMongoCompletionItems("db.users.aggregate([{ $m", "db.users.aggregate([{ $m".length);
  const match = items.find((item) => item.label === "$match");

  assert.equal(match?.info, "aggregation stage");
  assert.equal(match?.detail, "Filters documents");
  assert.equal(match?.apply, "$match: { ${} }");
});

test("completion context is tolerant of unfinished input", () => {
  const context = getMongoCompletionContext('db.getCollection("users").find({ "', 'db.getCollection("users").find({ "'.length);

  assert.equal(context.mode, "field");
  assert.equal(context.collection, "users");
});

test("method-shaped text inside a string value does not break field completion", () => {
  // The call locator must skip string contents; otherwise the ".aggregate(" decoy
  // is mistaken for the enclosing call and field completion collapses to nothing.
  assert.deepEqual(labels('db.users.find({ note: ".aggregate(", na', { fields }), ["name"]);
  assert.deepEqual(labels("db.users.find({ note: '.updateMany(', na", { fields }), ["name"]);
  // An escaped quote must not end the string early and re-expose the decoy.
  assert.deepEqual(labels('db.users.find({ note: "x\\".aggregate(", na', { fields }), ["name"]);
  // A brace or comma hidden in a string value must not corrupt container tracking.
  assert.deepEqual(labels('db.users.find({ note: "a}b,c", na', { fields }), ["name"]);
  // A string decoy in a sibling field must not stop the next field's operator list.
  assert.ok(labels('db.users.find({ note: ".find(", age: { $', { fields }).includes("$gte"));
});

test("does not suggest while the cursor is inside a comment", () => {
  // Line comments, anywhere.
  assert.deepEqual(labels("// db.users.fi"), []);
  assert.deepEqual(labels("db.users.find({})\n// some fi"), []);
  assert.deepEqual(labels("db.users.find({ // fi", { fields }), []);
  assert.deepEqual(labels("db.users.find({ name: 1 // comment na", { fields }), []);
  // Block comments, including the unterminated tail the user is still typing.
  assert.deepEqual(labels("/* db.users.fi"), []);
  assert.deepEqual(labels("db.users.find({ /* na", { fields }), []);
  assert.deepEqual(labels("db.users.find({ age: { // $", { fields }), []);
  // A closed comment does not suppress the code that follows it.
  assert.deepEqual(labels("db.users.find({ /* skip me */ na", { fields }), ["name"]);
  // A comment marker inside a string value is not a comment.
  assert.deepEqual(labels('db.users.find({ note: "http://x", na', { fields }), ["name"]);
});

test("treats -- as a line comment, matching the editor's SQL language mode", () => {
  // The editor hosts Mongo in SQL mode, so `--` comments like `//` — suppress inside them.
  assert.deepEqual(labels("-- db.users.fi"), []);
  assert.deepEqual(labels("db.users.find({ -- fi", { fields }), []);
  assert.deepEqual(labels("db.users.find({ age: { -- $", { fields }), []);
  // Code after a closed `--` line still completes.
  assert.deepEqual(labels("db.users.find({ name: 1, -- note\n  na", { fields }), ["name"]);
  // A double dash inside a string value is not a comment.
  assert.deepEqual(labels('db.users.find({ note: "a--b", na', { fields }), ["name"]);
});

test("method-shaped text inside a comment does not break field completion", () => {
  assert.deepEqual(labels("db.users.find({ /* .aggregate( */ na", { fields }), ["name"]);
  assert.deepEqual(labels("db.users.find({\n  // .updateMany(\n  na", { fields }), ["name"]);
  // Braces and commas inside a comment must not pop the container stack.
  assert.deepEqual(labels("db.users.find({ /* } , */ na", { fields }), ["name"]);
  // Operators are still offered after an inline comment.
  assert.ok(labels("db.users.find({ age: { /* x */ $", { fields }).includes("$gte"));
});

test("auto trigger opens for useful MongoDB characters only", () => {
  assert.equal(shouldAutoOpenMongoCompletion("db.", "db.".length), true);
  assert.equal(shouldAutoOpenMongoCompletion("db.users.find({ $", "db.users.find({ $".length), true);
  assert.equal(shouldAutoOpenMongoCompletion("db.users.find({", "db.users.find({".length), true);
});

test("keeps query and update operators in their own positions", () => {
  const filter = labels("db.users.find({ age: { $");
  assert.ok(filter.includes("$gte"));
  assert.equal(filter.includes("$set"), false, "update operators are not valid in a filter");

  const update = labels("db.users.updateOne({}, { $");
  assert.ok(update.includes("$set"));
  assert.equal(update.includes("$gte"), false, "query operators are not valid in an update document");
});

test("suggests fields under an update operator and array modifiers under $push", () => {
  assert.deepEqual(labels("db.users.updateOne({}, { $set: { ", { fields }), ["_id", "createdAt", "name", "profile.email"]);

  const modifiers = labels("db.users.updateOne({}, { $push: { tags: { ", { fields });
  assert.ok(modifiers.includes("$each"));
  assert.equal(modifiers.includes("$set"), false);
});

test("suggests fields inside a $match stage rather than operators", () => {
  const items = buildMongoCompletionItems("db.users.aggregate([{ $match: { na", "db.users.aggregate([{ $match: { na".length, { fields });

  assert.deepEqual(
    items.map((item) => item.label),
    ["name"],
  );
});

test("suggests query operators against a field inside a $match stage", () => {
  const items = labels("db.users.aggregate([{ $match: { age: { $g", { fields });

  assert.ok(items.includes("$gte"));
  assert.equal(items.includes("$group"), false, "a stage is not valid inside a $match constraint");
});

test("suggests accumulators, not stages, for a $group output field", () => {
  const items = labels('db.users.aggregate([{ $group: { _id: "$name", total: { $', { fields });

  assert.ok(items.includes("$sum"));
  assert.ok(items.includes("$avg"));
  assert.equal(items.includes("$match"), false, "stages are only valid at pipeline level");
});

test("suggests quoted field references in aggregation expression positions", () => {
  const groupKey = buildMongoCompletionItems('db.users.aggregate([{ $group: { _id: "$', 'db.users.aggregate([{ $group: { _id: "$'.length, { fields });
  const email = groupKey.find((item) => item.label === "$profile.email");

  assert.equal(email?.apply, '"$profile.email"');
  assert.equal(email?.detail, "field reference · string");

  // Also offered unquoted, where accepting the item supplies the quotes.
  const projection = buildMongoCompletionItems("db.users.aggregate([{ $project: { upper: ", "db.users.aggregate([{ $project: { upper: ".length, { fields });
  assert.equal(projection.find((item) => item.label === "$name")?.apply, '"$name"');
});

test("suggests $lookup option keys and collections for its from option", () => {
  assert.deepEqual(labels("db.users.aggregate([{ $lookup: { fr", { collections }), ["from"]);

  const from = buildMongoCompletionItems('db.users.aggregate([{ $lookup: { from: "us', 'db.users.aggregate([{ $lookup: { from: "us'.length, { collections });
  assert.deepEqual(
    from.map((item) => item.label),
    ["users", "user_events"],
  );
  assert.equal(from[0]?.apply, '"users"', "a collection in string position keeps its quotes");
});

test("suggests stages only at pipeline level, including nested pipelines", () => {
  assert.ok(labels("db.users.aggregate([{ $m").includes("$match"));
  assert.ok(labels("db.users.aggregate([{ $facet: { recent: [{ $m").includes("$match"));
  assert.ok(labels('db.users.aggregate([{ $lookup: { from: "orders", pipeline: [{ $m').includes("$match"));
  // A plain value array is not a pipeline.
  assert.equal(labels("db.users.aggregate([{ $match: { tags: { $in: [{ $m").includes("$match"), false);
});

test("suggests values, not fields, after a filter key", () => {
  const items = labels("db.users.find({ _id: ", { fields });

  assert.ok(items.includes("ObjectId"));
  assert.ok(items.includes("ISODate"));
  assert.equal(items.includes("name"), false, "field names are only valid in key position");
});

test("stays quiet inside string values, comments and unmodelled arguments", () => {
  assert.deepEqual(labels('db.users.find({ name: "Ad', { fields }), []);
  assert.deepEqual(labels("// db.users.fi", { fields }), []);
  assert.deepEqual(labels('db.users.find({ _id: ObjectId("6a04', { fields }), []);
  assert.deepEqual(labels("db.users.updateOne({}, { $set: {} }, { up", { fields }), []);
});

test("suggests only helpers the shell parser accepts", () => {
  const methodLabels = labels("db.users.");

  assert.ok(methodLabels.includes("count"));
  assert.ok(methodLabels.includes("drop"));
  assert.ok(methodLabels.includes("distinct"));
  // Suggesting a helper DBX cannot run just hands the user a command that fails.
  for (const unsupported of ["bulkWrite", "estimatedDocumentCount", "replaceOne"]) {
    assert.equal(methodLabels.includes(unsupported), false, `${unsupported} is not executable`);
  }
  // Cursor methods are not collection methods.
  assert.equal(methodLabels.includes("limit"), false);
});

test("completes both arguments of distinct", () => {
  const method = buildMongoCompletionItems("db.users.dist", "db.users.dist".length).find((item) => item.label === "distinct");
  assert.equal(method?.apply, 'users.distinct("${field}")');

  // First argument names a field, so it is completed as a quoted path.
  const fieldArg = buildMongoCompletionItems('db.users.distinct("pro', 'db.users.distinct("pro'.length, { fields });
  assert.deepEqual(
    fieldArg.map((item) => item.label),
    ["profile.email"],
  );
  assert.equal(fieldArg[0]?.apply, '"profile.email"');

  // Second argument is a filter, so it behaves like find()'s.
  const filterArg = labels('db.users.distinct("name", { ', { fields });
  assert.deepEqual(filterArg, ["_id", "createdAt", "name", "profile.email"]);
  assert.ok(labels('db.users.distinct("name", { age: { $g', { fields }).includes("$gte"));
});

test("suggests the use and db.version commands", () => {
  assert.equal(buildMongoCompletionItems("us", 2).find((item) => item.label === "use")?.apply, "use ${database}");
  // Database helpers stay reachable after `db.`, alongside the collection names.
  assert.ok(labels("db.vers", { collections }).includes("version"));
  assert.equal(labels("db.getColl", { collections }).includes("getCollection"), true);
});

test("ranks everyday operators above the long tail", () => {
  const queryOperators = labels("db.users.find({ age: { $").slice(0, 10);
  assert.ok(queryOperators.includes("$eq"));
  assert.ok(queryOperators.includes("$in"));
  assert.equal(queryOperators.includes("$bitsAllClear"), false);

  const stages = labels("db.users.aggregate([{ $").slice(0, 10);
  assert.ok(stages.includes("$match"));
  assert.ok(stages.includes("$group"));
  assert.equal(stages.includes("$planCacheStats"), false);
});

test("snippet templates use placeholder syntax CodeMirror actually honours", () => {
  const templates = [...QUERY_OPERATORS, ...UPDATE_OPERATORS, ...PUSH_MODIFIERS, ...PIPELINE_STAGES, ...ACCUMULATORS, ...EXPRESSION_OPERATORS, ...VALUE_SNIPPETS, ...Object.values(STAGE_OPTION_KEYS).flat()];
  assert.ok(templates.length > 200);

  for (const { label, apply } of templates) {
    // `${10}` reads as tab stop number 10 with no text, so the default is silently
    // dropped on accept. Numeric defaults have to be written literally.
    assert.equal(/\$\{\d+\}/.test(apply), false, `${label} has a numeric placeholder that would insert nothing: ${apply}`);
    // Placeholder names cannot nest braces — the parser stops at the first `}`.
    assert.equal(/\$\{[^{}]*\{/.test(apply), false, `${label} has a nested brace in a placeholder: ${apply}`);
  }
});

test("infers dotted MongoDB fields from sampled documents", () => {
  const inferred = inferMongoCompletionFields([
    { _id: "1", profile: { email: "a@example.com" }, tags: ["a"] },
    { _id: "2", profile: { age: 3 }, tags: [{ label: "vip" }] },
  ]);

  assert.ok(inferred.find((field) => field.name === "profile.email" && field.type === "string"));
  assert.ok(inferred.find((field) => field.name === "profile.age" && field.type === "number"));
  assert.ok(inferred.find((field) => field.name === "tags.label" && field.type === "string"));
});
