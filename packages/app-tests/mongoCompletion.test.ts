import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  buildMongoCompletionItems,
  buildMongoCompletionItemsFromContext,
  formatMongoIndexKeyPattern,
  getMongoCompletionContext,
  getMongoCompletionResultValidFor,
  getMongoDocumentQueryCompletionContext,
  inferMongoCompletionFields,
  mongoCompletionNeedsIndexes,
  shouldAutoOpenMongoCompletion,
} from "../../apps/desktop/src/lib/mongo/mongoCompletion.ts";
import {
  ACCUMULATORS,
  BULK_WRITE_OPERATION_FIELDS,
  BULK_WRITE_OPERATIONS,
  ENUM_VALUES,
  EXPRESSION_OPERATORS,
  EXTENDED_JSON_VALUES,
  KEY_MAP_VALUES,
  METHOD_OPTION_KEYS,
  OPERATOR_SUB_KEYS,
  PIPELINE_STAGES,
  PROJECTION_OPERATORS,
  PUSH_MODIFIERS,
  QUERY_OPERATORS,
  STAGE_OPTION_KEYS,
  UPDATE_OPERATORS,
  VALUE_SNIPPETS,
  WINDOW_OPERATORS,
} from "../../apps/desktop/src/lib/mongo/mongoCompletionTables.ts";
import { parseMongoCommand } from "../../apps/desktop/src/lib/mongo/mongoShellCommand.ts";

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

test("continues getCollection snippets with collection-name completion", () => {
  const rootItem = buildMongoCompletionItems("", 0).find((item) => item.label === "db.getCollection");
  const methodItem = buildMongoCompletionItems("db.getC", "db.getC".length).find((item) => item.label === "getCollection");

  assert.equal(rootItem?.apply, 'db.getCollection("${}")');
  assert.equal(methodItem?.apply, 'getCollection("${}")');
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

// The editor filters options against the document text from `from` to the
// cursor, so every item must be matchable by the whole prefix it replaces —
// a bare `find` label under a `users.fi` prefix is silently dropped.
test("makes collection-qualified methods matchable by the prefix they replace", () => {
  for (const text of ["db.users.", "db.users.fi", "db.audit."]) {
    const context = getMongoCompletionContext(text, text.length);
    const prefix = text.slice(context.from);
    for (const item of buildMongoCompletionItems(text, text.length, { collections })) {
      const matchable = item.filterText ?? item.label;
      assert.ok(matchable.toLowerCase().startsWith(prefix.toLowerCase()), `"${matchable}" is not matchable by the typed "${prefix}"`);
    }
  }

  const item = buildMongoCompletionItems("db.users.fi", "db.users.fi".length, { collections }).find((candidate) => candidate.label === "find");
  assert.equal(item?.filterText, "users.find");
});

test("stops reusing a completion result once the typed text gains a dot", () => {
  const validFor = (text: string) => {
    const pattern = getMongoCompletionResultValidFor(getMongoCompletionContext(text, text.length));
    return (typed: string) => new RegExp(`^(?:${pattern.source})$`).test(typed);
  };

  // `db.` lists collections; typing `users` keeps that list usable, `users.` does not.
  const afterDb = validFor("db.");
  assert.equal(afterDb("users"), true);
  assert.equal(afterDb("users."), false);

  // `db.users.` lists methods; narrowing to `users.fi` keeps them, a further dot does not.
  const afterCollection = validFor("db.users.");
  assert.equal(afterCollection("users.fi"), true);
  assert.equal(afterCollection("users.find."), false);
  assert.equal(afterCollection("users"), false);

  // Dots inside a quoted collection name are part of the identifier, not a scope change.
  const insideGetCollection = validFor('db.getCollection("audit.');
  assert.equal(insideGetCollection('"audit.logs'), true);
});

test("suggests dotted names inside getCollection", () => {
  const text = 'db.getCollection("audit.';
  const item = buildMongoCompletionItems(text, text.length, { collections }).find((candidate) => candidate.label === "audit.logs");

  assert.equal(item?.apply, '"audit.logs"');
  assert.equal(item?.filterText, '"audit.logs"');
});

test("replaces an existing closing quote when completing an emptied collection name", () => {
  const text = 'db.getCollection("")';
  const cursor = text.indexOf('""') + 1;
  const context = getMongoCompletionContext(text, cursor);
  const item = buildMongoCompletionItems(text, cursor, { collections }).find((candidate) => candidate.label === "users");

  assert.equal(context.mode, "collectionRef");
  assert.equal(context.from, text.indexOf('""'));
  assert.equal(context.replaceClosingQuote, '"');
  assert.equal(item?.replaceClosingQuote, '"');
  assert.equal(item?.filterText, '"users"');
  assert.equal(text.slice(0, context.from) + item?.apply + text.slice(cursor + 1), 'db.getCollection("users")');
  assert.equal(shouldAutoOpenMongoCompletion(text, cursor), true);
});

test("suggests collection methods after direct and getCollection references", () => {
  assert.ok(labels("db.users.").includes("find"));
  assert.ok(labels('db.getCollection("users").ag').includes("aggregate"));
});

test("prioritizes common read helpers and keeps destructive helpers last", () => {
  const methodLabels = labels("db.users.");
  const getCollectionMethodLabels = labels('db.getCollection("order-events").');

  assert.deepEqual(labels("").slice(0, 5), ["db.collection.find", "db.collection.aggregate", "db.getCollection", "use", "db.version"]);
  assert.deepEqual(methodLabels.slice(0, 6), ["find", "findOne", "aggregate", "countDocuments", "estimatedDocumentCount", "distinct"]);
  assert.deepEqual(getCollectionMethodLabels.slice(0, 6), ["find", "findOne", "aggregate", "countDocuments", "estimatedDocumentCount", "distinct"]);
  assert.deepEqual(methodLabels.slice(-3), ["dropIndex", "dropIndexes", "drop"]);
  assert.deepEqual(labels("db.users.find({})."), ["limit", "sort", "skip", "count", "explain", "collation", "toArray", "pretty"]);
});

test("keeps dotted collection names ahead of methods until the collection is resolved", () => {
  assert.equal(labels("db.audit.", { collections })[0], "audit.logs");
  assert.equal(labels("db.users.", { collections })[0], "find");
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
    ["limit", "sort", "skip", "count", "explain", "collation", "toArray", "pretty"],
  );
  assert.deepEqual(
    prefixedItems.map((item) => item.label),
    ["limit"],
  );
  assert.deepEqual(
    formattedChainItems.map((item) => item.label),
    ["limit", "sort", "skip", "count", "explain", "collation", "toArray", "pretty"],
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
  assert.equal(labels("db.characters.find({}).toArray().").includes("count"), false);
  assert.equal(labels("db.characters.find({}).pretty().").includes("count"), false);
  assert.equal(labels("db.characters.aggregate([]).").includes("count"), false);
});

test("offers only accepted cursor methods toArray and pretty after aggregate", () => {
  // The executor rejects limit, sort, skip, explain, etc. after aggregate(), accepting only toArray() and pretty().
  assert.deepEqual(labels("db.characters.aggregate([])."), ["toArray", "pretty"]);
  assert.deepEqual(labels("db.characters.aggregate([], { allowDiskUse: true })."), ["toArray", "pretty"]);
  assert.deepEqual(labels("db.characters.aggregate([]).toArray()."), ["toArray", "pretty"]);
  assert.deepEqual(labels("db.characters.aggregate([]).pretty()."), ["toArray", "pretty"]);
  assert.deepEqual(labels("db.characters.aggregate([]).to"), ["toArray"]);
  assert.deepEqual(labels("db.characters.aggregate([]).pr"), ["pretty"]);

  for (const rejected of ["limit", "sort", "skip", "explain", "collation", "count"]) {
    assert.equal(labels("db.characters.aggregate([]).").includes(rejected), false, `${rejected} should not be offered after aggregate()`);
  }
});

test("recognises toArray and pretty in find chains and keeps count restricted", () => {
  const expectedChainMethods = ["limit", "sort", "skip", "explain", "collation", "toArray", "pretty"];
  assert.deepEqual(labels("db.characters.find({}).toArray()."), expectedChainMethods);
  assert.deepEqual(labels("db.characters.find({}).pretty()."), expectedChainMethods);
  assert.deepEqual(labels("db.characters.find({}).sort({ name: 1 }).toArray()."), expectedChainMethods);
});

test("stops offering root snippets after terminal cursor methods count and explain", () => {
  // Nothing can follow count() or explain(); these positions must yield mode "none" rather than root db.* snippets.
  assert.equal(getMongoCompletionContext("db.users.find({}).count().", "db.users.find({}).count().".length).mode, "none");
  assert.deepEqual(labels("db.users.find({}).count()."), []);
  assert.deepEqual(labels("db.users.find({}).count().db"), []);
  assert.deepEqual(labels("db.characters.find({}).count()."), []);

  assert.equal(getMongoCompletionContext("db.users.find({}).explain().", "db.users.find({}).explain().".length).mode, "none");
  assert.deepEqual(labels("db.users.find({}).explain()."), []);
  assert.deepEqual(labels('db.users.find({}).explain("executionStats").'), []);
  assert.deepEqual(labels("db.users.find({}).sort({ name: 1 }).explain()."), []);
  assert.deepEqual(labels("db.users.find({}).explain().db"), []);
  assert.deepEqual(labels("db.users.find({}).explain().lim"), []);

  assert.deepEqual(labels("db.users.aggregate([]).count()."), []);
  assert.deepEqual(labels("db.users.aggregate([]).explain()."), []);
  assert.deepEqual(labels("db.users.aggregate([]).limit(5)."), []);
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

test("suggests extended JSON wrappers in value positions", () => {
  const apply = (text: string, label: string) => buildMongoCompletionItems(text, text.length, { fields }).find((item) => item.label === label)?.apply;

  // A bare value gets the braces added; inside `{` the wrapper body is enough.
  assert.equal(apply("db.users.find({ _id: $o", "$oid"), '{ $oid: "${id}" }');
  assert.equal(apply("db.users.find({ _id: { $oi", "$oid"), '$oid: "${id}"');
  assert.equal(apply("db.users.updateOne({}, { $set: { seen: $d", "$date"), '{ $date: "${date}" }');
  assert.equal(apply("db.users.insertOne({ key: $u", "$uuid"), '{ $uuid: "${uuid}" }');

  // Query operators stay available alongside the wrappers under a field.
  const under = buildMongoCompletionItems("db.users.find({ _id: { $", "db.users.find({ _id: { $".length, { fields });
  assert.ok(under.find((item) => item.label === "$gt"));
  assert.ok(under.find((item) => item.label === "$oid"));

  // The most common wrappers sort first at a bare `$`.
  const bare = buildMongoCompletionItems("db.users.find({ _id: $", "db.users.find({ _id: $".length, { fields });
  assert.deepEqual(
    bare.slice(0, 2).map((item) => item.label),
    ["$date", "$oid"],
  );
});

test("treats $in, $nin and $all elements as values rather than sub-filters", () => {
  const labels = (text: string) => buildMongoCompletionItems(text, text.length, { fields }).map((item) => item.label);

  assert.ok(labels("db.users.find({ _id: { $in: [").includes("ObjectId"));
  assert.ok(labels("db.users.find({ _id: { $in: [{ $o").includes("$oid"));
  assert.equal(labels("db.users.find({ _id: { $in: [{ $o").includes("_id"), false);
  assert.ok(labels("db.users.find({ tags: { $all: [").includes("ObjectId"));
  assert.equal(labels('db.users.find({ _id: { $in: ["').length, 0);

  // `$or` / `$and` arrays still hold sub-filters, so their objects complete fields.
  assert.ok(labels("db.users.find({ $or: [{ ").includes("name"));
  assert.equal(labels("db.users.find({ $or: [{ ").includes("$oid"), false);
});

test("offers the newly supported count and database commands", () => {
  assert.ok(labels("db.users.estim", { fields }).includes("estimatedDocumentCount"));
  const dbLevel = labels("db.");
  assert.ok(dbLevel.includes("stats"));
  assert.ok(dbLevel.includes("serverStatus"));
  assert.ok(dbLevel.includes("createCollection"));
  assert.ok(dbLevel.includes("dropDatabase"));
  assert.ok(labels("").includes("db.stats"));
});

test("offers the newer shell value constructors", () => {
  const labels = buildMongoCompletionItems("db.users.find({ _id: ", "db.users.find({ _id: ".length, { fields }).map((item) => item.label);
  for (const constructor of ["NumberInt", "NumberDecimal", "UUID", "BinData", "Timestamp", "MinKey", "MaxKey"]) {
    assert.ok(labels.includes(constructor), constructor);
  }
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

  assert.equal(context.mode, "filterField");
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

test("offers whole-filter operators at the top level and field operators under a field", () => {
  // `$and` / `$or` belong at the top of a filter, where nothing was offered before.
  const top = labels("db.users.find({ $", { fields });
  assert.ok(top.includes("$or"));
  assert.ok(top.includes("$and"));
  assert.ok(top.includes("$expr"));
  assert.equal(top.includes("$gte"), false, "field operators are not valid at the top level");

  // Under a field only the constraint operators apply; `{ _id: { $or: ... } }` is invalid.
  const under = labels("db.users.find({ _id: { $", { fields });
  assert.ok(under.includes("$gte"));
  assert.ok(under.includes("$oid"));
  assert.equal(under.includes("$or"), false, "$or is not valid under a field");
  assert.equal(under.includes("$and"), false);
  assert.deepEqual(labels("db.users.find({ _id: { $o", { fields }), ["$oid"]);

  // Fields lead when nothing has been typed yet.
  const bare = labels("db.users.find({ ", { fields });
  assert.ok(
    bare.slice(0, fields.length).every((label) => !label.startsWith("$")),
    `fields first: ${bare.join(", ")}`,
  );
  assert.ok(bare.includes("$or"));
});

test("treats $and / $or sub-filters and $match as filters", () => {
  for (const text of ["db.users.find({ $or: [{ $", "db.users.aggregate([{ $match: { $"]) {
    const items = labels(text, { fields });
    assert.ok(items.includes("$or"), text);
    assert.equal(items.includes("$gte"), false, text);
  }
  assert.ok(labels("db.users.find({ $or: [{ ", { fields }).includes("name"));
  assert.ok(labels("db.users.find({ $or: [{ age: { $", { fields }).includes("$gte"));
});

test("completes $elemMatch body with field names, field query operators and logical operators", () => {
  const findItems = labels("db.users.find({ tags: { $elemMatch: { $", { fields });
  for (const op of ["$gte", "$lt", "$in", "$regex", "$exists", "$and", "$or", "$nor"]) {
    assert.ok(findItems.includes(op), `find $elemMatch must include ${op}`);
  }
  for (const op of ["$expr", "$text", "$where", "$jsonSchema"]) {
    assert.equal(findItems.includes(op), false, `find $elemMatch must exclude ${op}`);
  }

  const bare = labels("db.users.find({ tags: { $elemMatch: { ", { fields });
  assert.ok(
    bare.slice(0, fields.length).every((label) => !label.startsWith("$")),
    `fields first: ${bare.join(", ")}`,
  );
  assert.deepEqual(bare.slice(0, fields.length), ["_id", "createdAt", "name", "profile.email"]);

  assert.ok(labels("db.users.find({ tags: { $elemMatch: { qty: { $", { fields }).includes("$gte"));
  assert.ok(labels("db.users.find({ tags: { $elemMatch: { $or: [{ ", { fields }).includes("name"));

  const aggItems = labels("db.users.aggregate([{ $match: { tags: { $elemMatch: { $", { fields });
  for (const op of ["$gte", "$lt", "$in", "$regex", "$exists", "$and", "$or", "$nor"]) {
    assert.ok(aggItems.includes(op), `aggregate $elemMatch must include ${op}`);
  }
  for (const op of ["$expr", "$text", "$where", "$jsonSchema"]) {
    assert.equal(aggItems.includes(op), false, `aggregate $elemMatch must exclude ${op}`);
  }
});

test("does not offer filter operators in update or insert documents", () => {
  assert.equal(labels("db.users.updateOne({}, { $set: { ", { fields }).includes("$or"), false);
  assert.equal(labels("db.users.insertOne({ $", { fields }).length, 0);
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

  const pullOperators = labels("db.users.updateOne({}, { $pull: { tags: { $", { fields });
  assert.ok(pullOperators.includes("$gte"));
  assert.ok(pullOperators.includes("$in"));
  assert.equal(pullOperators.includes("$set"), false);
  assert.equal(pullOperators.includes("name"), false);

  assert.deepEqual(labels("db.users.updateOne({}, { $pull: { tags: { na", { fields }), ["name"]);
  assert.ok(labels("db.users.updateOne({}, { $pull: { tags: { $in: [").includes("ObjectId"));
  assert.equal(labels("db.users.updateOne({}, { $pullAll: { tags: [").length, 0);
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

test("filters and replaces quoted fields, field references and operators", () => {
  const quotedFieldText = 'db.users.find({ "" })';
  const quotedFieldCursor = quotedFieldText.indexOf('""') + 1;
  const quotedField = buildMongoCompletionItems(quotedFieldText, quotedFieldCursor, { fields }).find((item) => item.label === "name");
  assert.equal(quotedField?.apply, '"name": ');
  assert.equal(quotedField?.filterText, '"name": ');
  assert.equal(quotedField?.replaceClosingQuote, '"');
  assert.equal(quotedFieldText.slice(0, getMongoCompletionContext(quotedFieldText, quotedFieldCursor).from) + quotedField?.apply + quotedFieldText.slice(quotedFieldCursor + 1), 'db.users.find({ "name":  })');

  const quotedRefText = 'db.users.aggregate([{ $group: { _id: "" } }])';
  const quotedRefCursor = quotedRefText.indexOf('""') + 1;
  const quotedRef = buildMongoCompletionItems(quotedRefText, quotedRefCursor, { fields }).find((item) => item.label === "$name");
  assert.equal(quotedRef?.apply, '"$name"');
  assert.equal(quotedRef?.filterText, '"$name"');
  assert.equal(quotedRef?.replaceClosingQuote, '"');
  assert.equal(quotedRefText.slice(0, getMongoCompletionContext(quotedRefText, quotedRefCursor).from) + quotedRef?.apply + quotedRefText.slice(quotedRefCursor + 1), 'db.users.aggregate([{ $group: { _id: "$name" } }])');

  const quotedOperatorText = 'db.users.find({ age: { "" } })';
  const quotedOperatorCursor = quotedOperatorText.indexOf('""') + 1;
  const quotedOperator = buildMongoCompletionItems(quotedOperatorText, quotedOperatorCursor).find((item) => item.label === "$gte");
  assert.equal(quotedOperator?.apply, '"$gte": ${}');
  assert.equal(quotedOperator?.filterText, '"$gte": ${}');
  assert.equal(quotedOperator?.replaceClosingQuote, '"');
  assert.equal(quotedOperatorText.slice(0, getMongoCompletionContext(quotedOperatorText, quotedOperatorCursor).from) + quotedOperator?.apply + quotedOperatorText.slice(quotedOperatorCursor + 1), 'db.users.find({ age: { "$gte": ${} } })');
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

test("suggests field references in elements of expression operator arrays across stages and $expr", () => {
  // Elements of an expression operator's array argument get suggestions
  // $project
  const projectConcat = labels('db.users.aggregate([{ $project: { n: { $concat: ["$', { fields });
  assert.ok(projectConcat.includes("$name"));
  assert.ok(projectConcat.includes("$profile.email"));

  // Bare element outside quotes offers field references (with quoted apply)
  const projectAddBare = buildMongoCompletionItems("db.users.aggregate([{ $project: { n: { $add: [", "db.users.aggregate([{ $project: { n: { $add: [".length, { fields });
  const nameItem = projectAddBare.find((item) => item.label === "$name");
  assert.equal(nameItem?.apply, '"$name"');

  // Inside { within an array, offers expression operators
  const projectAddObject = labels("db.users.aggregate([{ $project: { n: { $add: [ { $", { fields });
  assert.ok(projectAddObject.includes("$multiply"));
  assert.ok(projectAddObject.includes("$sum"));

  // $expr in $match
  const matchExpr = labels('db.users.aggregate([{ $match: { $expr: { $gt: ["$', { fields });
  assert.ok(matchExpr.includes("$name"));
  assert.ok(matchExpr.includes("$profile.email"));

  // $expr in find()
  const findExpr = labels('db.users.find({ $expr: { $eq: ["$', { fields });
  assert.ok(findExpr.includes("$name"));
  assert.ok(findExpr.includes("$profile.email"));

  // $addFields
  const addFieldsSum = labels("db.users.aggregate([{ $addFields: { n: { $sum: [", { fields });
  assert.ok(addFieldsSum.includes("$name"));

  // $set
  const setMultiply = labels('db.users.aggregate([{ $set: { n: { $multiply: ["$', { fields });
  assert.ok(setMultiply.includes("$name"));

  // $group accumulators
  const groupSum = labels('db.users.aggregate([{ $group: { _id: "$_id", total: { $sum: ["$', { fields });
  assert.ok(groupSum.includes("$name"));
  const groupSumObject = labels('db.users.aggregate([{ $group: { _id: "$_id", total: { $sum: [ { $', { fields });
  assert.ok(groupSumObject.includes("$multiply"));

  // Update pipeline stages
  const updatePipeline = labels('db.users.updateOne({}, [{ $set: { n: { $concat: ["$', { fields });
  assert.ok(updatePipeline.includes("$name"));

  // Plain filter $in / $nin / $all unchanged
  const plainInQuoted = labels('db.users.find({ age: { $in: ["$', { fields });
  assert.equal(plainInQuoted.length, 0);
  const plainInBare = labels("db.users.find({ age: { $in: [", { fields });
  assert.equal(plainInBare.includes("$name"), false);
  assert.ok(plainInBare.includes("ObjectId"));
});

test("suggests accumulator operators as expressions in $project and other stages", () => {
  const projectOps = labels("db.users.aggregate([{ $project: { n: { $ma");
  assert.ok(projectOps.includes("$max"));

  const maxItem = buildMongoCompletionItems("db.users.aggregate([{ $project: { n: { $max", "db.users.aggregate([{ $project: { n: { $max".length).find((i) => i.label === "$max");
  assert.equal(maxItem?.apply, "$max: [${}, ${}]");

  const sumItem = buildMongoCompletionItems("db.users.aggregate([{ $project: { n: { $sum", "db.users.aggregate([{ $project: { n: { $sum".length).find((i) => i.label === "$sum");
  assert.equal(sumItem?.apply, "$sum: [${}, ${}]");

  const avgItem = buildMongoCompletionItems("db.users.aggregate([{ $project: { n: { $avg", "db.users.aggregate([{ $project: { n: { $avg".length).find((i) => i.label === "$avg");
  assert.equal(avgItem?.apply, "$avg: [${}, ${}]");

  const minItem = buildMongoCompletionItems("db.users.aggregate([{ $project: { n: { $min", "db.users.aggregate([{ $project: { n: { $min".length).find((i) => i.label === "$min");
  assert.equal(minItem?.apply, "$min: [${}, ${}]");

  const stdDevPopItem = buildMongoCompletionItems("db.users.aggregate([{ $project: { n: { $stdDevPop", "db.users.aggregate([{ $project: { n: { $stdDevPop".length).find((i) => i.label === "$stdDevPop");
  assert.equal(stdDevPopItem?.apply, "$stdDevPop: [${}, ${}]");

  const stdDevSampItem = buildMongoCompletionItems("db.users.aggregate([{ $project: { n: { $stdDevSamp", "db.users.aggregate([{ $project: { n: { $stdDevSamp".length).find((i) => i.label === "$stdDevSamp");
  assert.equal(stdDevSampItem?.apply, "$stdDevSamp: [${}, ${}]");
});

test("suggests system and scoped user variables when typing '$$'", () => {
  // Single '$' offers fields, not variables
  const singleDollar = labels('db.users.aggregate([{ $project: { n: "$', { fields });
  assert.ok(singleDollar.includes("$name"));
  assert.equal(singleDollar.includes("$$ROOT"), false);

  // '$$' switches to variables
  const varsInProject = labels('db.users.aggregate([{ $project: { n: "$$');
  assert.ok(varsInProject.includes("$$ROOT"));
  assert.ok(varsInProject.includes("$$CURRENT"));
  assert.ok(varsInProject.includes("$$NOW"));
  assert.ok(varsInProject.includes("$$CLUSTER_TIME"));
  assert.ok(varsInProject.includes("$$REMOVE"));
  assert.ok(varsInProject.includes("$$DESCEND"));
  assert.ok(varsInProject.includes("$$PRUNE"));
  assert.ok(varsInProject.includes("$$KEEP"));

  // $redact ranks $$DESCEND / $$PRUNE / $$KEEP higher
  const redactText = 'db.users.aggregate([{ $redact: { $cond: { if: 1, then: "$$';
  const projectText = 'db.users.aggregate([{ $project: { n: "$$';
  const redactVars = buildMongoCompletionItems(redactText, redactText.length);
  const redactDescend = redactVars.find((i) => i.label === "$$DESCEND");
  const projectDescend = buildMongoCompletionItems(projectText, projectText.length).find((i) => i.label === "$$DESCEND");
  assert.ok((redactDescend?.boost ?? 0) > (projectDescend?.boost ?? 0));

  // In expression array
  const concatVars = labels('db.users.aggregate([{ $project: { n: { $concat: ["$$');
  assert.ok(concatVars.includes("$$ROOT"));

  // In find $expr
  const findExprVars = labels('db.users.find({ $expr: { $eq: ["$$');
  assert.ok(findExprVars.includes("$$ROOT"));

  // $map scope: as: "item" offers $$item only inside in:
  const mapIn = labels('db.users.aggregate([{ $project: { n: { $map: { input: "$arr", as: "item", in: "$$');
  assert.ok(mapIn.includes("$$item"));
  assert.ok(mapIn.includes("$$ROOT"));

  const mapInNested = labels('db.users.aggregate([{ $project: { n: { $map: { input: "$arr", as: "item", in: { $concat: ["$$');
  assert.ok(mapInNested.includes("$$item"));

  const mapInput = labels('db.users.aggregate([{ $project: { n: { $map: { as: "item", input: "$$');
  assert.equal(mapInput.includes("$$item"), false);

  // $map without as defaults to $$this
  const mapDefault = labels('db.users.aggregate([{ $project: { n: { $map: { input: "$arr", in: "$$');
  assert.ok(mapDefault.includes("$$this"));

  // $filter scope: as: "item" offers $$item inside cond, not input
  const filterCond = labels('db.users.aggregate([{ $project: { n: { $filter: { input: "$arr", as: "item", cond: "$$');
  assert.ok(filterCond.includes("$$item"));
  const filterInput = labels('db.users.aggregate([{ $project: { n: { $filter: { as: "item", input: "$$');
  assert.equal(filterInput.includes("$$item"), false);

  // $reduce scope: offers $$value and $$this inside in
  const reduceIn = labels('db.users.aggregate([{ $project: { n: { $reduce: { input: "$arr", initialValue: 0, in: "$$');
  assert.ok(reduceIn.includes("$$value"));
  assert.ok(reduceIn.includes("$$this"));
  const reduceInit = labels('db.users.aggregate([{ $project: { n: { $reduce: { input: "$arr", in: "$$value", initialValue: "$$');
  assert.equal(reduceInit.includes("$$value"), false);

  // $let.vars scope
  const letIn = labels('db.users.aggregate([{ $project: { n: { $let: { vars: { total: 10, discount: 2 }, in: "$$');
  assert.ok(letIn.includes("$$total"));
  assert.ok(letIn.includes("$$discount"));

  // $lookup.let scope
  const lookupLet = labels('db.users.aggregate([{ $lookup: { from: "orders", let: { order_id: "$_id" }, pipeline: [{ $project: { n: "$$');
  assert.ok(lookupLet.includes("$$order_id"));
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

test("withholds illegal stages in sub-pipelines and view definitions", () => {
  // Top-level aggregate includes $out and $merge.
  const topLevel = labels("db.users.aggregate([{ $");
  assert.ok(topLevel.includes("$out"));
  assert.ok(topLevel.includes("$merge"));
  assert.ok(topLevel.includes("$match"));
  assert.ok(topLevel.includes("$project"));
  assert.ok(topLevel.includes("$group"));

  // $facet branch rejects $out, $merge, $facet, $collStats, $indexStats, $planCacheStats, $geoNear, $documents.
  const facetStages = labels("db.users.aggregate([{ $facet: { a: [{ $");
  for (const forbidden of ["$out", "$merge", "$facet", "$collStats", "$indexStats", "$planCacheStats", "$geoNear", "$documents"]) {
    assert.equal(facetStages.includes(forbidden), false, `$facet branch must not offer ${forbidden}`);
  }
  assert.ok(facetStages.includes("$match"));
  assert.ok(facetStages.includes("$project"));
  assert.ok(facetStages.includes("$group"));

  // $lookup sub-pipeline rejects $out and $merge, but permits $documents, $facet, $geoNear.
  const lookupStages = labels('db.users.aggregate([{ $lookup: { from: "orders", pipeline: [{ $');
  assert.equal(lookupStages.includes("$out"), false, "$lookup must not offer $out");
  assert.equal(lookupStages.includes("$merge"), false, "$lookup must not offer $merge");
  assert.ok(lookupStages.includes("$match"));
  assert.ok(lookupStages.includes("$project"));
  assert.ok(lookupStages.includes("$group"));
  assert.ok(lookupStages.includes("$documents"));
  assert.ok(lookupStages.includes("$facet"));
  assert.ok(lookupStages.includes("$geoNear"));

  // $unionWith sub-pipeline rejects $out and $merge, but permits $documents.
  const unionStages = labels('db.users.aggregate([{ $unionWith: { coll: "orders", pipeline: [{ $');
  assert.equal(unionStages.includes("$out"), false, "$unionWith must not offer $out");
  assert.equal(unionStages.includes("$merge"), false, "$unionWith must not offer $merge");
  assert.ok(unionStages.includes("$match"));
  assert.ok(unionStages.includes("$project"));
  assert.ok(unionStages.includes("$group"));
  assert.ok(unionStages.includes("$documents"));

  // View definition pipeline rejects $out and $merge, but permits $documents.
  const viewStages = labels('db.createCollection("v", { viewOn: "users", pipeline: [{ $');
  assert.equal(viewStages.includes("$out"), false, "view pipeline must not offer $out");
  assert.equal(viewStages.includes("$merge"), false, "view pipeline must not offer $merge");
  assert.ok(viewStages.includes("$match"));
  assert.ok(viewStages.includes("$project"));
  assert.ok(viewStages.includes("$group"));
  assert.ok(viewStages.includes("$documents"));

  // Sub-pipeline nested inside a view pipeline applies sub-pipeline restrictions.
  const viewFacetStages = labels('db.createCollection("v", { viewOn: "users", pipeline: [{ $facet: { a: [{ $');
  assert.equal(viewFacetStages.includes("$out"), false);
  assert.equal(viewFacetStages.includes("$merge"), false);
  assert.equal(viewFacetStages.includes("$facet"), false);
  assert.equal(viewFacetStages.includes("$geoNear"), false);
  assert.ok(viewFacetStages.includes("$match"));

  // runCommand aggregate pipeline is a top-level aggregate and offers $out and $merge.
  const runCommandStages = labels('db.runCommand({ aggregate: "users", pipeline: [{ $');
  assert.ok(runCommandStages.includes("$out"));
  assert.ok(runCommandStages.includes("$merge"));
  assert.ok(runCommandStages.includes("$match"));

  // Update pipeline remains unchanged.
  const updateStages = labels("db.users.updateOne({}, [{ $", { fields });
  assert.deepEqual([...updateStages].sort(), ["$addFields", "$project", "$replaceRoot", "$replaceWith", "$set", "$unset"]);
});

test("classifies pipeline kinds across top-level, sub-pipelines, views and updates", () => {
  const topText = "db.users.aggregate([{ $";
  assert.equal(getMongoCompletionContext(topText, topText.length).pipelineKind, "aggregate");
  assert.equal(getMongoCompletionContext(topText, topText.length).stage, undefined);

  const facetText = "db.users.aggregate([{ $facet: { a: [{ $";
  const facetCtx = getMongoCompletionContext(facetText, facetText.length);
  assert.equal(facetCtx.pipelineKind, "facet");
  assert.equal(facetCtx.stage, undefined);

  const lookupText = 'db.users.aggregate([{ $lookup: { from: "orders", pipeline: [{ $';
  const lookupCtx = getMongoCompletionContext(lookupText, lookupText.length);
  assert.equal(lookupCtx.pipelineKind, "join");
  assert.equal(lookupCtx.stage, undefined);

  const unionText = 'db.users.aggregate([{ $unionWith: { coll: "orders", pipeline: [{ $';
  const unionCtx = getMongoCompletionContext(unionText, unionText.length);
  assert.equal(unionCtx.pipelineKind, "join");
  assert.equal(unionCtx.stage, undefined);

  const viewText = 'db.createCollection("v", { viewOn: "users", pipeline: [{ $';
  const viewCtx = getMongoCompletionContext(viewText, viewText.length);
  assert.equal(viewCtx.pipelineKind, "view");
  assert.equal(viewCtx.stage, undefined);

  const runCommandText = 'db.runCommand({ aggregate: "users", pipeline: [{ $';
  const runCommandCtx = getMongoCompletionContext(runCommandText, runCommandText.length);
  assert.equal(runCommandCtx.pipelineKind, "aggregate");
  assert.equal(runCommandCtx.stage, undefined);

  const updateText = "db.users.updateOne({}, [{ $";
  const updateCtx = getMongoCompletionContext(updateText, updateText.length);
  assert.equal(updateCtx.pipelineKind, "update");
  assert.equal(updateCtx.stage, undefined);
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
  // An operation name bulkWrite() does not accept has no fields to offer.
  assert.deepEqual(labels("db.users.bulkWrite([{ mapReduceOne: { ", { fields }), []);
});

test("suggests only helpers the shell parser accepts", () => {
  const methodLabels = labels("db.users.");

  assert.ok(methodLabels.includes("count"));
  assert.ok(methodLabels.includes("drop"));
  assert.ok(methodLabels.includes("distinct"));
  assert.ok(methodLabels.includes("estimatedDocumentCount"));
  assert.ok(methodLabels.includes("replaceOne"));
  assert.ok(methodLabels.includes("bulkWrite"));
  assert.ok(methodLabels.includes("renameCollection"));
  // Suggesting a helper DBX cannot run just hands the user a command that fails.
  for (const unsupported of ["mapReduce", "watch", "validate"]) {
    assert.equal(methodLabels.includes(unsupported), false, `${unsupported} is not executable`);
  }
  // Cursor methods are not collection methods.
  assert.equal(methodLabels.includes("limit"), false);
});

test("suggests the option keys of methods that take an options argument", () => {
  assert.deepEqual(labels("db.users.updateOne({}, {$set:{a:1}}, { "), ["arrayFilters", "upsert"]);
  assert.deepEqual(labels("db.users.updateOne({}, {$set:{a:1}}, { ups"), ["upsert"]);
  assert.deepEqual(labels("db.users.replaceOne({}, {}, { "), ["upsert"]);
  assert.deepEqual(labels("db.users.findOneAndDelete({}, { "), ["projection", "sort"]);
  assert.deepEqual(labels("db.users.bulkWrite([], { "), ["ordered"]);
  assert.deepEqual(labels("db.users.findOne({}, {}, { "), ["sort"]);
  assert.ok(labels("db.users.findOneAndUpdate({}, {$set:{a:1}}, { ").includes("returnDocument"));
  assert.ok(labels("db.users.createIndex({a:1}, { ").includes("expireAfterSeconds"));
  assert.ok(labels("db.users.aggregate([], { ").includes("allowDiskUse"));

  // A `sort` or `projection` option holds field names.
  assert.deepEqual(labels("db.users.findOneAndUpdate({}, {$set:{a:1}}, { sort: { na", { fields }), ["name"]);
  assert.deepEqual(labels("db.users.findOneAndDelete({}, { projection: { na", { fields }), ["name"]);

  // An `arrayFilters` option holds filter documents.
  assert.deepEqual(labels('db.users.updateOne({}, { $set: { "tags.$[e].x": 1 } }, { arrayFilters: [{ na', { fields }), ["name"]);
  assert.ok(labels('db.users.updateOne({}, { $set: { "tags.$[e].x": 1 } }, { arrayFilters: [{ "tags.x": { $', { fields }).includes("$gte"));
  assert.deepEqual(labels('db.users.updateMany({}, { $set: { "tags.$[e].x": 1 } }, { arrayFilters: [{ na', { fields }), ["name"]);
  assert.deepEqual(labels('db.users.findOneAndUpdate({}, { $set: { "tags.$[e].x": 1 } }, { arrayFilters: [{ na', { fields }), ["name"]);
});

test("stays quiet in the trailing argument of methods that take no options", () => {
  // Suggesting an option key here would hand the user a command the parser rejects.
  for (const text of ["db.users.find({}, {}, { ", "db.users.insertOne({}, { ", "db.users.insertMany([], { ", "db.users.deleteOne({}, { ", "db.users.deleteMany({}, { ", "db.users.countDocuments({}, { "]) {
    assert.deepEqual(labels(text, { fields, collections }), [], text);
  }
});

test("completes legacy insert helper arguments and stays quiet in trailing arguments", () => {
  assert.ok(labels("db.users.").includes("insert"));
  assert.ok(labels("db.users.ins").includes("insert"));
  assert.ok(labels("ins").includes("insert"));

  // Both document and array shapes complete collection fields
  assert.deepEqual(labels("db.users.insert({ na", { fields }), ["name"]);
  assert.deepEqual(labels("db.users.insert([{ na", { fields }), ["name"]);
  assert.ok(labels("db.users.insert({ name: ", { fields }).includes("ObjectId"));
  assert.ok(labels("db.users.insert([{ name: ", { fields }).includes("ObjectId"));

  // Stays quiet in trailing options argument because insert takes no options
  assert.deepEqual(labels("db.users.insert({}, { ", { fields, collections }), []);
  assert.deepEqual(labels("db.users.insert([{}], { ", { fields, collections }), []);

  // Every new insert snippet shape parses
  assert.ok(parseMongoCommand("db.users.insert({})"));
  assert.ok(parseMongoCommand("db.users.insert([{}])"));
});

test("every suggested option key parses on the method that offers it", () => {
  // The option sets mirror the driver's own structs, most of which reject unknown fields, so a
  // key that only exists in this table would complete into a command that fails at Run.
  const values: Record<string, string> = {
    upsert: "true",
    arrayFilters: '[{ "e.f": 1 }]',
    returnDocument: '"after"',
    returnNewDocument: "true",
    new: "true",
    projection: "{ name: 1 }",
    sort: "{ name: -1 }",
    ordered: "false",
    name: '"idx"',
    unique: "true",
    sparse: "true",
    expireAfterSeconds: "3600",
    partialFilterExpression: "{ name: { $exists: true } }",
    collation: '{ locale: "en" }',
    hidden: "true",
    allowDiskUse: "true",
    maxTimeMS: "5000",
    hint: '"idx"',
    comment: '"why"',
    let: "{ n: 1 }",
    explain: "true",
  };
  const callArgs: Record<string, string> = {
    findOne: "{}, {}",
    updateOne: "{}, {$set:{a:1}}",
    updateMany: "{}, {$set:{a:1}}",
    replaceOne: "{}, {b:1}",
    findOneAndUpdate: "{}, {$set:{a:1}}",
    findOneAndReplace: "{}, {b:1}",
    findOneAndDelete: "{}",
    bulkWrite: "[{ insertOne: { document: { a: 1 } } }]",
    createIndex: "{a:1}",
    aggregate: "[]",
  };

  for (const [method, options] of Object.entries(METHOD_OPTION_KEYS)) {
    if (method === "createCollection" || method === "runCommand" || method === "createUser") continue; // database-level: pinned from their own templates below
    const args = callArgs[method];
    assert.ok(args !== undefined, `${method} needs sample arguments in this test`);
    for (const option of options) {
      const value = values[option.label];
      assert.ok(value !== undefined, `${option.label} needs a sample value in this test`);
      const command = `db.users.${method}(${args}, { ${option.label}: ${value} })`;
      assert.ok(parseMongoCommand(command), `${command} must parse`);
    }
  }
});

test("suggests the values a field-to-value map accepts", () => {
  assert.deepEqual(labels("db.users.find({}).sort({ name: ", { fields }), ["-1", "1"]);
  assert.deepEqual(labels("db.users.aggregate([{ $sort: { name: ", { fields }), ["-1", "1"]);
  assert.deepEqual(labels("db.users.find({}, { name: ", { fields }), ["0", "1"]);
  assert.deepEqual(labels("db.users.findOne({}, { name: ", { fields }), ["0", "1"]);
  assert.deepEqual(labels("db.users.createIndex({ name: ", { fields }), ["-1", '"2d"', '"2dsphere"', '"hashed"', '"text"', "1"]);

  // The sort and projection options of the find-and-modify helpers are the same maps.
  assert.deepEqual(labels("db.users.findOneAndUpdate({}, {$set:{a:1}}, { sort: { name: ", { fields }), ["-1", "1"]);
  assert.deepEqual(labels("db.users.findOneAndDelete({}, { projection: { name: ", { fields }), ["0", "1"]);

  // Keys are still field names, and a second key in the same map still gets values.
  assert.deepEqual(labels("db.users.find({}).sort({ na", { fields }), ["name"]);
  assert.deepEqual(labels("db.users.find({}).sort({ name: 1, createdAt: ", { fields }), ["-1", "1"]);

  // Inside a quote the engine stays quiet, as it does for every other value position.
  assert.deepEqual(labels('db.users.createIndex({ name: "', { fields }), []);

  // The document browser's sort bar is the same map without a surrounding command.
  const sortBar = getMongoDocumentQueryCompletionContext("{ name: ", "{ name: ".length, "sortKeys");
  assert.deepEqual(
    buildMongoCompletionItemsFromContext(sortBar, { fields }).map((item) => item.label),
    ["-1", "1"],
  );
});

test("every suggested map value parses in the position that offers it", () => {
  const commands: Record<string, (value: string) => string> = {
    sort: (value) => `db.users.find({}).sort({ name: ${value} })`,
    projection: (value) => `db.users.find({}, { name: ${value} })`,
    index: (value) => `db.users.createIndex({ name: ${value} })`,
  };
  for (const [keyMap, values] of Object.entries(KEY_MAP_VALUES)) {
    const build = commands[keyMap];
    assert.ok(build, `${keyMap} needs a sample command in this test`);
    for (const value of values) {
      assert.ok(parseMongoCommand(build(value.label)), build(value.label));
    }
  }
});

test("suggests projection operators in find projections", () => {
  const ops = ["$elemMatch", "$meta", "$slice"];
  assert.deepEqual(labels("db.users.find({}, { tags: { ", { fields }), ops);
  assert.deepEqual(labels("db.users.find({}, { tags: { $", { fields }), ops);
  assert.deepEqual(labels("db.users.findOne({}, { tags: { ", { fields }), ops);
  assert.deepEqual(labels("db.users.findOneAndUpdate({}, { $set: { a: 1 } }, { projection: { tags: { ", { fields }), ops);
  assert.deepEqual(labels("db.users.findOneAndDelete({}, { projection: { tags: { ", { fields }), ops);

  // Positional operator form needs nothing new and still completes map values
  assert.deepEqual(labels('db.users.find({}, { "tags.$": ', { fields }), ["0", "1"]);

  // $slice takes only numbers, so completion offers nothing
  assert.deepEqual(labels("db.users.find({}, { tags: { $slice: ", { fields }), []);
  assert.deepEqual(labels("db.users.find({}, { tags: { $slice: [", { fields }), []);

  // $meta value enum in and out of quotes
  assert.deepEqual(labels('db.users.find({}, { score: { $meta: "', { fields }), ["textScore", "indexKey"]);
  assert.deepEqual(labels('db.users.find({}, { score: { $meta: "text', { fields }), ["textScore"]);
  assert.deepEqual(labels("db.users.find({}, { score: { $meta: ", { fields }), ["textScore", "indexKey"]);

  const quotedMeta = buildMongoCompletionItems('db.users.find({}, { score: { $meta: "', 'db.users.find({}, { score: { $meta: "'.length);
  const unquotedMeta = buildMongoCompletionItems("db.users.find({}, { score: { $meta: ", "db.users.find({}, { score: { $meta: ".length);
  assert.equal(quotedMeta.find((item) => item.label === "textScore")?.apply, '"textScore"');
  assert.equal(unquotedMeta.find((item) => item.label === "textScore")?.apply, '"textScore"');
  assert.equal(getMongoCompletionContext('db.users.find({}, { score: { $meta: "" } })', 'db.users.find({}, { score: { $meta: "'.length).replaceClosingQuote, '"');

  // $elemMatch body completes fields and filter operators
  assert.deepEqual(labels("db.users.find({}, { tags: { $elemMatch: { ", { fields }).slice(0, 3), ["_id", "createdAt", "name"]);
  assert.ok(labels("db.users.find({}, { tags: { $elemMatch: { score: { ", { fields }).includes("$gt"));
  assert.ok(labels("db.users.find({}, { tags: { $elemMatch: { score: { $gt: ", { fields }).includes("NumberInt"));
  const projElemMatch = labels("db.users.find({}, { tags: { $elemMatch: { $", { fields });
  assert.ok(projElemMatch.includes("$gte"));
  assert.ok(projElemMatch.includes("$or"));
  assert.equal(projElemMatch.includes("$expr"), false);
});

test("every suggested projection operator parses", () => {
  const render = (op: { label: string; apply: string }) => {
    if (op.label === "$elemMatch") return "$elemMatch: { score: 1 }";
    return op.apply.replace(/\$\{([^{}]*)\}/g, (_, name: string) => name || "1");
  };
  for (const op of PROJECTION_OPERATORS) {
    const command = `db.users.find({}, { tags: { ${render(op)} } })`;
    assert.ok(parseMongoCommand(command), `${command} must parse`);
  }
});

test("offers nothing rather than top-level snippets inside an unmodelled argument", () => {
  // `db.collection.find` is not something that can be typed inside these parentheses, so the
  // top-level snippets are noise there; the engine stays quiet until the argument is modelled.
  for (const text of ["db.users.find({}).limit(", "db.users.find({}).skip(", "db.users.drop(", "db.users.renameCollection(", 'db.users.dropIndex("', "db.users.estimatedDocumentCount(", 'db.createCollection("']) {
    assert.deepEqual(labels(text, { fields, collections }), [], text);
  }

  // A command still starts with the top-level snippets, including after one has finished.
  assert.ok(labels("").includes("db.collection.find"));
  assert.ok(labels("db.users.find({});\n").includes("db.collection.find"));
  assert.ok(labels("db.users.find({})\n").includes("db.collection.find"));
  // A parenthesis inside a string does not count as an open argument list.
  assert.ok(labels('db.users.find({ name: "(" });\n').includes("db.collection.find"));
});

test("completes commands addressed to another database through getSiblingDB", () => {
  // The parser accepts `db.getSiblingDB("x").coll.find(…)`, so the editor has to complete it the
  // same way it completes `db.coll.find(…)` — including resolving the collection, which is what
  // loads field names.
  // Addressing another database offers what `db.` offers, except `getSiblingDB` itself — the
  // parser rejects chaining it, and accepting that suggestion would produce a statement that
  // cannot run.
  const siblingRoot = labels('db.getSiblingDB("archive").', { collections });
  assert.deepEqual(
    siblingRoot,
    labels("db.", { collections }).filter((label: string) => label !== "getSiblingDB"),
  );
  assert.ok(!siblingRoot.includes("getSiblingDB"));
  assert.equal(getMongoCompletionContext('db.getSiblingDB("archive").', 'db.getSiblingDB("archive").'.length).database, "archive");
  assert.deepEqual(labels('db.getSiblingDB("archive").user_ev', { collections }), ["user_events"]);

  const methods = labels('db.getSiblingDB("archive").users.', { collections });
  assert.ok(methods.includes("find") && methods.includes("updateOne"));
  assert.equal(getMongoCompletionContext('db.getSiblingDB("archive").users.', 'db.getSiblingDB("archive").users.'.length).collection, "users");

  assert.deepEqual(labels('db.getSiblingDB("archive").users.find({ na', { fields }), ["name"]);
  assert.ok(labels('db.getSiblingDB("archive").users.find({}).', { fields }).includes("limit"));
  assert.ok(labels("db.getSiblingDB('archive').users.updateOne({}, { $s", { fields }).includes("$set"));
  assert.deepEqual(labels('db.getSiblingDB("archive").getCollection("user_ev', { collections }), ["user_events"]);
  assert.equal(getMongoCompletionContext('db.getSiblingDB("archive").getCollection("users").', 'db.getSiblingDB("archive").getCollection("users").'.length).collection, "users");
});

test("completes bulkWrite operations, their fields, and the shapes inside them", () => {
  assert.deepEqual(labels("db.users.bulkWrite([{ "), ["deleteMany", "deleteOne", "insertOne", "replaceOne", "updateMany", "updateOne"]);
  assert.deepEqual(labels("db.users.bulkWrite([{ upd"), ["updateMany", "updateOne"]);

  assert.deepEqual(labels("db.users.bulkWrite([{ insertOne: { "), ["document"]);
  assert.deepEqual(labels("db.users.bulkWrite([{ deleteMany: { "), ["filter"]);
  assert.deepEqual(labels("db.users.bulkWrite([{ replaceOne: { "), ["filter", "replacement", "upsert"]);
  assert.deepEqual(labels("db.users.bulkWrite([{ updateOne: { "), ["arrayFilters", "filter", "update", "upsert"]);

  // Inside a field the shapes are the ordinary ones.
  assert.ok(labels("db.users.bulkWrite([{ updateOne: { filter: { ", { fields }).includes("$or"));
  assert.deepEqual(labels("db.users.bulkWrite([{ updateOne: { filter: { na", { fields }), ["name"]);
  assert.ok(labels("db.users.bulkWrite([{ updateOne: { filter: { age: { $g", { fields }).includes("$gte"));
  assert.ok(labels("db.users.bulkWrite([{ updateOne: { update: { $s", { fields }).includes("$set"));
  assert.deepEqual(labels("db.users.bulkWrite([{ updateOne: { update: { $set: { na", { fields }), ["name"]);
  assert.deepEqual(labels("db.users.bulkWrite([{ insertOne: { document: { na", { fields }), ["name"]);
  assert.deepEqual(labels("db.users.bulkWrite([{ replaceOne: { replacement: { na", { fields }), ["name"]);
  assert.deepEqual(labels("db.users.bulkWrite([{ updateOne: { arrayFilters: [{ na", { fields }), ["name"]);

  // An operation the parser does not accept has nothing to offer.
  assert.deepEqual(labels("db.users.bulkWrite([{ notAnOperation: { ", { fields }), []);
});

test("every suggested bulkWrite operation and field parses", () => {
  // The parser rejects an unknown operation key and an unknown field inside one, so a suggestion
  // that only exists in the table would complete into a command that fails at Run.
  const fieldValues: Record<string, string> = {
    document: "{ a: 1 }",
    filter: "{ a: 1 }",
    update: "{ $set: { b: 2 } }",
    replacement: "{ b: 2 }",
    upsert: "true",
    arrayFilters: '[{ "e.f": 1 }]',
  };

  assert.deepEqual(BULK_WRITE_OPERATIONS.map((operation) => operation.label).sort(), Object.keys(BULK_WRITE_OPERATION_FIELDS).sort(), "every offered operation needs a field list, and vice versa");

  for (const [operation, fieldSpecs] of Object.entries(BULK_WRITE_OPERATION_FIELDS)) {
    // Every field of an operation at once, so each one is exercised against the parser.
    const body = fieldSpecs
      .map((field) => {
        const value = fieldValues[field.label];
        assert.ok(value !== undefined, `${field.label} needs a sample value in this test`);
        return `${field.label}: ${value}`;
      })
      .join(", ");
    const command = `db.users.bulkWrite([{ ${operation}: { ${body} } }])`;
    assert.ok(parseMongoCommand(command), `${command} must parse`);
  }
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
  assert.deepEqual(filterArg.slice(0, 4), ["_id", "createdAt", "name", "profile.email"]);
  assert.ok(filterArg.includes("$or"), "a filter argument offers whole-filter operators after the fields");
  assert.ok(labels('db.users.distinct("name", { age: { $g', { fields }).includes("$gte"));
});

test("completes index names in dropIndex, dropIndexes and aggregate hint", () => {
  const sampleIndexes = [
    { name: "_id_", keyPattern: "{ _id: 1 }" },
    { name: "email_1", keyPattern: "{ email: 1 }" },
    { name: "name_age_idx", keyPattern: "{ name: 1, age: -1 }" },
  ];

  // Needs-helper correctly identifies indexName mode.
  assert.equal(mongoCompletionNeedsIndexes("indexName"), true);
  assert.equal(mongoCompletionNeedsIndexes("collection"), false);
  assert.equal(mongoCompletionNeedsIndexes("none"), false);

  // dropIndex excludes _id_ and completes index names of the collection.
  const dropIndexText = 'db.users.dropIndex("';
  const dropIndexCtx = getMongoCompletionContext(dropIndexText, dropIndexText.length);
  assert.equal(dropIndexCtx.mode, "indexName");
  assert.equal(dropIndexCtx.collection, "users");
  assert.equal(dropIndexCtx.prefix, '"');

  const dropIndexItems = buildMongoCompletionItems(dropIndexText, dropIndexText.length, { indexes: sampleIndexes });
  assert.deepEqual(
    dropIndexItems.map((item) => item.label),
    ["email_1", "name_age_idx"],
  );
  assert.equal(
    dropIndexItems.find((i) => i.label === "_id_"),
    undefined,
  );
  assert.equal(dropIndexItems.find((i) => i.label === "name_age_idx")?.detail, "{ name: 1, age: -1 }");
  assert.equal(dropIndexItems[0]?.apply, '"email_1"');

  // dropIndex handles string-only index inputs as well.
  const stringIndexItems = buildMongoCompletionItems(dropIndexText, dropIndexText.length, { indexes: ["_id_", "username_1"] });
  assert.deepEqual(
    stringIndexItems.map((item) => item.label),
    ["username_1"],
  );

  // dropIndex replaces existing closing quote when completing an emptied quote pair.
  const dropIndexEmpty = 'db.users.dropIndex("")';
  const dropIndexEmptyCursor = dropIndexEmpty.indexOf('""') + 1;
  const dropIndexEmptyContext = getMongoCompletionContext(dropIndexEmpty, dropIndexEmptyCursor);
  const dropIndexEmptyItem = buildMongoCompletionItems(dropIndexEmpty, dropIndexEmptyCursor, { indexes: sampleIndexes }).find((i) => i.label === "email_1");
  assert.equal(dropIndexEmptyContext.replaceClosingQuote, '"');
  assert.equal(dropIndexEmptyItem?.replaceClosingQuote, '"');
  assert.equal(dropIndexEmpty.slice(0, dropIndexEmptyContext.from) + dropIndexEmptyItem?.apply + dropIndexEmpty.slice(dropIndexEmptyCursor + 1), 'db.users.dropIndex("email_1")');

  // dropIndexes (bare string argument) excludes _id_.
  const dropIndexesBareText = 'db.users.dropIndexes("';
  const dropIndexesBareCtx = getMongoCompletionContext(dropIndexesBareText, dropIndexesBareText.length);
  assert.equal(dropIndexesBareCtx.mode, "indexName");
  assert.equal(dropIndexesBareCtx.collection, "users");
  const dropIndexesBareItems = buildMongoCompletionItems(dropIndexesBareText, dropIndexesBareText.length, { indexes: sampleIndexes });
  assert.deepEqual(
    dropIndexesBareItems.map((item) => item.label),
    ["email_1", "name_age_idx"],
  );

  // dropIndexes (array of string index names) excludes _id_.
  const dropIndexesArrayText = 'db.users.dropIndexes(["';
  const dropIndexesArrayCtx = getMongoCompletionContext(dropIndexesArrayText, dropIndexesArrayText.length);
  assert.equal(dropIndexesArrayCtx.mode, "indexName");
  assert.equal(dropIndexesArrayCtx.collection, "users");
  const dropIndexesArrayItems = buildMongoCompletionItems(dropIndexesArrayText, dropIndexesArrayText.length, { indexes: sampleIndexes });
  assert.deepEqual(
    dropIndexesArrayItems.map((item) => item.label),
    ["email_1", "name_age_idx"],
  );

  // Subsequent items in dropIndexes array also complete index names.
  const dropIndexesNextArrayText = 'db.users.dropIndexes(["email_1", "';
  const dropIndexesNextArrayCtx = getMongoCompletionContext(dropIndexesNextArrayText, dropIndexesNextArrayText.length);
  assert.equal(dropIndexesNextArrayCtx.mode, "indexName");
  assert.equal(dropIndexesNextArrayCtx.collection, "users");
  const dropIndexesNextItems = buildMongoCompletionItems(dropIndexesNextArrayText, dropIndexesNextArrayText.length, { indexes: sampleIndexes });
  assert.deepEqual(
    dropIndexesNextItems.map((item) => item.label),
    ["email_1", "name_age_idx"],
  );

  // aggregate({ hint: "..." }) includes _id_ (hinting _id_ is allowed in MongoDB).
  const aggHintText = 'db.users.aggregate([], { hint: "';
  const aggHintCtx = getMongoCompletionContext(aggHintText, aggHintText.length);
  assert.equal(aggHintCtx.mode, "indexName");
  assert.equal(aggHintCtx.collection, "users");
  const aggHintItems = buildMongoCompletionItems(aggHintText, aggHintText.length, { indexes: sampleIndexes });
  assert.deepEqual(
    aggHintItems.map((item) => item.label),
    ["_id_", "email_1", "name_age_idx"],
  );
  assert.equal(aggHintItems.find((i) => i.label === "_id_")?.detail, "{ _id: 1 }");

  // find().hint() is NOT in find chain and does not offer index completion.
  const findHintText = 'db.users.find({}).hint("';
  assert.notEqual(getMongoCompletionContext(findHintText, findHintText.length).mode, "indexName");

  // Key pattern formatter formats directions properly.
  assert.equal(
    formatMongoIndexKeyPattern([
      { field: "name", direction: "1" },
      { field: "age", direction: "-1" },
    ]),
    "{ name: 1, age: -1 }",
  );
  assert.equal(formatMongoIndexKeyPattern([{ field: "loc", direction: "2dsphere" }]), '{ loc: "2dsphere" }');
  assert.equal(formatMongoIndexKeyPattern([]), undefined);
  assert.equal(formatMongoIndexKeyPattern(null), undefined);
});

test("completes database names after use and inside getSiblingDB", () => {
  const databases = ["orders", "order_archive", "admin", "local"];

  // `use ` takes a bare name, inserted as typed.
  assert.deepEqual(labels("use ", { databases }), ["orders", "order_archive", "admin", "local"]);
  assert.deepEqual(labels("use ord", { databases }), ["orders", "order_archive"]);
  assert.deepEqual(getMongoCompletionContext("use ord", 7), { mode: "database", prefix: "ord", from: 4 });
  assert.equal(buildMongoCompletionItems("use ord", 7, { databases })[0]?.apply, "orders");
  // Whitespace and earlier commands do not get in the way.
  assert.deepEqual(labels("db.users.find({}); use ord", { databases }), ["orders", "order_archive"]);
  assert.deepEqual(labels("use   ord", { databases }), ["orders", "order_archive"]);
  assert.deepEqual(labels("use\tord", { databases }), ["orders", "order_archive"]);
  // The list opens as soon as the space after `use` is typed, and stays open while the name is typed.
  assert.equal(shouldAutoOpenMongoCompletion("use ", 4), true);
  assert.equal(shouldAutoOpenMongoCompletion("use ord", 7), true);
  // Without a database list the position is still quiet rather than showing root snippets.
  assert.deepEqual(labels("use ", { fields, collections }), []);
  assert.deepEqual(labels("use ord", { fields, collections }), []);

  // `getSiblingDB("…")` takes a quoted name, and the completion keeps the quotes.
  assert.deepEqual(labels('db.getSiblingDB("', { databases }), ["orders", "order_archive", "admin", "local"]);
  assert.deepEqual(labels('db.getSiblingDB("ord', { databases }), ["orders", "order_archive"]);
  assert.equal(buildMongoCompletionItems('db.getSiblingDB("ord', 20, { databases })[0]?.apply, '"orders"');
  assert.equal(buildMongoCompletionItems("db.getSiblingDB('ord", 20, { databases })[0]?.apply, "'orders'");
  assert.deepEqual(getMongoCompletionContext('db.getSiblingDB("ord")', 20), { mode: "database", prefix: '"ord', from: 16, replaceClosingQuote: '"' });
  assert.deepEqual(labels("db . getSiblingDB( 'ord", { databases }), ["orders", "order_archive"]);
  // Root snippets do not leak into the argument when nothing matches.
  assert.deepEqual(labels('db.getSiblingDB("zzz', { databases }), []);

  // A field that happens to be called `use` is a key, not the command: the filter keeps its own suggestions.
  const insideFilter = labels("db.users.find({ use ", { databases, fields });
  assert.notEqual(getMongoCompletionContext("db.users.find({ use ", 20).mode, "database");
  assert.ok(
    insideFilter.every((label) => !databases.includes(label)),
    insideFilter.join(", "),
  );
  // Neither is `use` inside a string or a comment.
  assert.deepEqual(labels('db.users.find({ name: "use ', { databases, fields }), []);
  assert.deepEqual(labels("// use ", { databases }), []);
});

test("honours a preceding use command and resolves active database", () => {
  // `use <db>` switches the active database for following commands in the script.
  const context = getMongoCompletionContext("use analytics\ndb.", "use analytics\ndb.".length);
  assert.equal(context.database, "analytics");
  assert.equal(context.mode, "collection");

  // Plain db root after `use` still offers getSiblingDB, unlike an explicit db.getSiblingDB(…) root.
  const items = labels("use x\ndb.", { collections });
  assert.ok(items.includes("getSiblingDB"));
  assert.ok(items.includes("users"));

  // Field completion inside a command carries the database set by preceding `use`.
  const fieldContext = getMongoCompletionContext("use analytics\ndb.users.find({ ", "use analytics\ndb.users.find({ ".length);
  assert.equal(fieldContext.database, "analytics");
  assert.equal(fieldContext.collection, "users");
  assert.ok(labels("use analytics\ndb.users.find({ na", { fields }).includes("name"));

  // An explicit db.getSiblingDB("b") on the current command wins over an earlier `use a`.
  const siblingOverride = getMongoCompletionContext('use a\ndb.getSiblingDB("b").users.find({ ', 'use a\ndb.getSiblingDB("b").users.find({ '.length);
  assert.equal(siblingOverride.database, "b");
  assert.equal(siblingOverride.collection, "users");

  // `use` inside comments or argument objects does not set the active database.
  assert.equal(getMongoCompletionContext("db.users.find({ use: 1 })", "db.users.find({ use: 1 })".length).database, undefined);
  assert.equal(getMongoCompletionContext("// use x\ndb.", "// use x\ndb.".length).database, undefined);
  assert.equal(getMongoCompletionContext("/* use x */\ndb.", "/* use x */\ndb.".length).database, undefined);

  // Across multiple `use` commands, the last one before the cursor wins.
  assert.equal(getMongoCompletionContext("use first\nuse second\ndb.", "use first\nuse second\ndb.".length).database, "second");

  // getSiblingDB on a previous command does not leak into a later plain db command.
  assert.equal(getMongoCompletionContext('use a\ndb.getSiblingDB("b").users.find({});\ndb.', 'use a\ndb.getSiblingDB("b").users.find({});\ndb.'.length).database, "a");

  // Long scripts with thousands of commands resolve without O(n^2) slicing overhead.
  const longScript = "db.users.find({});\n".repeat(2000) + "use big\ndb.";
  assert.equal(getMongoCompletionContext(longScript, longScript.length).database, "big");
});

test("completes the keys of an operator's own sub-document", () => {
  // `{ field: { $… } }` takes the field operators, but `$text` and the geo operators hold
  // documents with their own keys, where `$gt` and friends are nonsense.
  assert.deepEqual(labels("db.users.find({ $text: { ", { fields }), ["$caseSensitive", "$diacriticSensitive", "$language", "$search"]);
  assert.deepEqual(labels('db.users.find({ $text: { $search: "a", $lang', { fields }), ["$language"]);
  assert.deepEqual(labels("db.users.find({ loc: { $geoWithin: { ", { fields }), ["$box", "$center", "$centerSphere", "$geometry", "$polygon"]);
  assert.deepEqual(labels("db.users.find({ loc: { $geoIntersects: { ", { fields }), ["$geometry"]);
  assert.deepEqual(labels("db.users.find({ loc: { $near: { ", { fields }), ["$geometry", "$maxDistance", "$minDistance"]);
  assert.deepEqual(labels("db.users.find({ loc: { $nearSphere: { ", { fields }), ["$geometry", "$maxDistance", "$minDistance"]);
  assert.deepEqual(labels("db.users.find({ loc: { $near: { $geometry: { ", { fields }), ["coordinates", "type"]);
  // The same filter positions inside a stage, a bulk operation and the document browser's filter bar.
  assert.deepEqual(labels("db.users.aggregate([{ $match: { $text: { ", { fields }), ["$caseSensitive", "$diacriticSensitive", "$language", "$search"]);
  assert.deepEqual(labels("db.users.bulkWrite([{ deleteMany: { filter: { $text: { ", { fields }), ["$caseSensitive", "$diacriticSensitive", "$language", "$search"]);
  const bar = getMongoDocumentQueryCompletionContext("{ $text: { ", "{ $text: { ".length, "filter");
  assert.deepEqual(
    buildMongoCompletionItemsFromContext(bar).map((item) => item.label),
    ["$caseSensitive", "$diacriticSensitive", "$language", "$search"],
  );
  // A field that happens to be called `text` is still a field, and `$not` still wraps field operators.
  assert.ok(labels("db.users.find({ text: { $", { fields }).includes("$gt"));
  assert.ok(labels("db.users.find({ name: { $not: { $", { fields }).includes("$regex"));
  // Inside a value string the engine stays quiet, as everywhere else.
  assert.deepEqual(labels('db.users.find({ $text: { $search: "', { fields }), []);

  // `$currentDate` names fields, and each field's object takes `$type`.
  assert.deepEqual(labels("db.users.updateOne({}, { $currentDate: { ", { fields }).slice(0, 2), ["_id", "createdAt"]);
  assert.deepEqual(labels("db.users.updateOne({}, { $currentDate: { at: { ", { fields }), ["$type"]);
});

test("completes JSON Schema keywords inside $jsonSchema", () => {
  const keywords = labels("db.users.find({ $jsonSchema: { ", { fields });
  for (const keyword of ["bsonType", "required", "properties", "items", "allOf", "not", "pattern", "minimum"]) assert.ok(keywords.includes(keyword), keyword);
  assert.ok(!keywords.includes("$gt"), "field operators do not belong in a schema");
  // `properties` names fields; each named field's object is a schema again, however deep.
  assert.deepEqual(labels("db.users.find({ $jsonSchema: { properties: { ", { fields }), ["_id", "createdAt", "name", "profile.email"]);
  assert.deepEqual(labels("db.users.find({ $jsonSchema: { properties: { name: { ", { fields }), keywords);
  assert.deepEqual(labels("db.users.find({ $jsonSchema: { properties: { tags: { items: { ", { fields }), keywords);
  assert.deepEqual(labels("db.users.find({ $jsonSchema: { not: { ", { fields }), keywords);
  assert.deepEqual(labels("db.users.find({ $jsonSchema: { anyOf: [{ ", { fields }), keywords);
  assert.deepEqual(labels('db.users.find({ $jsonSchema: { patternProperties: { "^a": { ', { fields }), keywords);
  // `required` lists field paths; `bsonType` / `type` take the BSON aliases, alone or in a list.
  assert.deepEqual(labels('db.users.find({ $jsonSchema: { required: ["', { fields }), ["_id", "createdAt", "name", "profile.email"]);
  assert.ok(labels('db.users.find({ $jsonSchema: { properties: { name: { bsonType: "', { fields }).includes("objectId"));
  assert.ok(labels('db.users.find({ $jsonSchema: { properties: { name: { type: "', { fields }).includes("string"));
  assert.ok(labels('db.users.find({ $jsonSchema: { bsonType: ["', { fields }).includes("null"));
  // Other values, and lists of values, are the user's own.
  assert.deepEqual(labels('db.users.find({ $jsonSchema: { properties: { name: { description: "', { fields }), []);
  assert.deepEqual(labels("db.users.find({ $jsonSchema: { properties: { name: { enum: [", { fields }), []);
  // The `validator` of an index's partial filter is an ordinary filter, so the schema works there too.
  assert.deepEqual(labels("db.users.createIndex({ a: 1 }, { partialFilterExpression: { $jsonSchema: { properties: { name: { ", { fields }), keywords);
});

test("completes enumerated string values in and out of quotes", () => {
  const types = labels('db.users.find({ name: { $type: "', { fields });
  for (const alias of ["string", "objectId", "date", "int", "long", "double", "decimal", "number", "array", "null"]) assert.ok(types.includes(alias), alias);
  assert.deepEqual(labels('db.users.find({ name: { $type: "obj', { fields }), ["objectId", "object"]);
  assert.deepEqual(labels('db.users.find({ name: { $type: ["', { fields }), types);
  // Outside a quote the value arrives quoted; inside, bare, consuming the closing quote already typed.
  assert.equal(buildMongoCompletionItems("db.users.find({ name: { $type: ", 31, { fields })[0]?.apply, '"string"');
  assert.equal(buildMongoCompletionItems('db.users.find({ name: { $type: "', 32, { fields })[0]?.apply, '"string"');
  assert.equal(buildMongoCompletionItems("db.users.find({ name: { $type: 'str", 35, { fields })[0]?.apply, "'string'");
  assert.equal(getMongoCompletionContext('db.users.find({ name: { $type: "str" } })', 35).replaceClosingQuote, '"');
  assert.deepEqual(labels('db.users.find({ name: { $regex: "a", $options: "', { fields }), ["i", "m", "x", "s", "u"]);
  assert.deepEqual(labels('db.users.find({ loc: { $near: { $geometry: { type: "', { fields }), ["Point", "LineString", "Polygon", "MultiPoint", "MultiLineString", "MultiPolygon", "GeometryCollection"]);
  assert.deepEqual(labels('db.users.findOneAndUpdate({}, { $set: {} }, { returnDocument: "'), ["after", "before"]);
  assert.deepEqual(labels("db.users.findOneAndUpdate({}, { $set: {} }, { returnDocument: "), ["after", "before"]);
  assert.deepEqual(labels('db.users.updateOne({}, { $currentDate: { at: { $type: "'), ["date", "timestamp"]);
  // `explain()` takes a verbosity, the one argument the find chain accepts a value for.
  assert.deepEqual(labels('db.users.find({}).explain("'), ["queryPlanner", "executionStats", "allPlansExecution"]);
  assert.deepEqual(labels("db.users.find({}).explain("), ["queryPlanner", "executionStats", "allPlansExecution"]);
  assert.deepEqual(labels("db.users.find({}).explain(1, "), []);
  // The document browser's filter bar shares the value sets.
  const bar = getMongoDocumentQueryCompletionContext('{ name: { $type: "', '{ name: { $type: "'.length, "filter");
  assert.deepEqual(
    buildMongoCompletionItemsFromContext(bar).map((item) => item.label),
    types,
  );
});

test("suggests values that fit query operators and remaining fixed value sets", () => {
  // $exists takes only a boolean: true / false outside quotes, none inside quotes
  assert.deepEqual(labels("db.users.find({ name: { $exists: ", { fields }), ["true", "false"]);
  assert.deepEqual(labels('db.users.find({ name: { $exists: "', { fields }), []);

  // $size takes a non-negative integer: none
  assert.deepEqual(labels("db.users.find({ name: { $size: ", { fields }), []);
  assert.deepEqual(labels('db.users.find({ name: { $size: "', { fields }), []);

  // $mod takes numbers: none outside and inside brackets
  assert.deepEqual(labels("db.users.find({ name: { $mod: ", { fields }), []);
  assert.deepEqual(labels("db.users.find({ name: { $mod: [", { fields }), []);
  assert.deepEqual(labels('db.users.find({ name: { $mod: "', { fields }), []);

  // $regex offers a /pattern/ regex literal snippet outside quotes, none inside quotes
  assert.deepEqual(labels("db.users.find({ name: { $regex: ", { fields }), ["/pattern/"]);
  const regexItem = buildMongoCompletionItems("db.users.find({ name: { $regex: ", "db.users.find({ name: { $regex: ".length, { fields })[0];
  assert.equal(regexItem?.label, "/pattern/");
  assert.equal(regexItem?.type, "snippet");
  assert.equal(regexItem?.apply, "/${pattern}/");
  assert.deepEqual(labels('db.users.find({ name: { $regex: "', { fields }), []);

  // $options stays as is
  assert.deepEqual(labels('db.users.find({ name: { $regex: "a", $options: "', { fields }), ["i", "m", "x", "s", "u"]);
  assert.deepEqual(labels("db.users.find({ name: { $regex: 'a', $options: ", { fields }), ["i", "m", "x", "s", "u"]);

  // $text boolean options -> true/false; $language -> common codes/names + none
  assert.deepEqual(labels("db.users.find({ $text: { $caseSensitive: "), ["true", "false"]);
  assert.deepEqual(labels('db.users.find({ $text: { $caseSensitive: "'), []);
  assert.deepEqual(labels("db.users.find({ $text: { $diacriticSensitive: "), ["true", "false"]);
  assert.deepEqual(labels('db.users.find({ $text: { $diacriticSensitive: "'), []);
  const textLanguages = labels('db.users.find({ $text: { $language: "');
  for (const code of ["none", "en", "fr", "de", "es", "it", "pt", "ru", "english", "spanish"]) {
    assert.ok(textLanguages.includes(code), `expected $language to include ${code}`);
  }
  assert.ok(labels("db.users.find({ $text: { $language: ").includes("en"));

  // $elemMatch remains unchanged (completing filter fields inside its object)
  assert.deepEqual(labels("db.users.find({ items: { $elemMatch: { ", { fields }).slice(0, 3), ["_id", "createdAt", "name"]);

  // $gt / $eq / $in still offer the full value list (ObjectId, ISODate, etc.)
  const gtValues = labels("db.users.find({ age: { $gt: ", { fields });
  for (const expected of ["ObjectId", "ISODate", "new Date", "NumberLong", "NumberInt", "NumberDecimal", "UUID", "BinData", "Timestamp", "MinKey", "MaxKey", "null", "true", "false"]) {
    assert.ok(gtValues.includes(expected), `expected $gt to include ${expected}`);
  }
  const inValues = labels("db.users.find({ age: { $in: [", { fields });
  for (const expected of ["ObjectId", "ISODate", "NumberInt"]) {
    assert.ok(inValues.includes(expected), `expected $in to include ${expected}`);
  }

  // $merge whenMatched and whenNotMatched options
  assert.deepEqual(labels('db.users.aggregate([{ $merge: { whenMatched: "'), ["replace", "keepExisting", "merge", "fail"]);
  assert.deepEqual(labels("db.users.aggregate([{ $merge: { whenMatched: "), ["replace", "keepExisting", "merge", "fail"]);
  assert.deepEqual(labels('db.users.aggregate([{ $merge: { whenNotMatched: "'), ["insert", "discard", "fail"]);
  assert.deepEqual(labels("db.users.aggregate([{ $merge: { whenNotMatched: "), ["insert", "discard", "fail"]);
});

test("completes the collation document wherever it appears", () => {
  const keys = ["alternate", "backwards", "caseFirst", "caseLevel", "locale", "maxVariable", "normalization", "numericOrdering", "strength"];
  assert.deepEqual(labels("db.users.find({}).collation({ "), keys);
  assert.deepEqual(labels("db.users.aggregate([], { collation: { "), keys);
  assert.deepEqual(labels("db.users.createIndex({ a: 1 }, { collation: { "), keys);
  assert.deepEqual(labels('db.users.find({}).collation({ caseFirst: "'), ["off", "upper", "lower"]);
  assert.deepEqual(labels('db.users.find({}).collation({ alternate: "'), ["non-ignorable", "shifted"]);
  assert.deepEqual(labels('db.users.find({}).collation({ maxVariable: "'), ["punct", "space"]);
  assert.deepEqual(labels("db.users.find({}).collation({ strength: "), ["1", "2", "3", "4", "5"]);
  // Numbers are not offered inside a quote.
  assert.deepEqual(labels('db.users.find({}).collation({ strength: "'), []);
  assert.deepEqual(labels('db.users.find({}).collation({ locale: "'), ["simple", "en", "fr", "de", "es", "pt", "it", "ru", "zh", "ja", "ko", "ar"]);
  assert.deepEqual(labels("db.users.find({}).collation({ locale: "), ["simple", "en", "fr", "de", "es", "pt", "it", "ru", "zh", "ja", "ko", "ar"]);
  // The chain continues after collation(), and collation() is a find-cursor method only.
  assert.deepEqual(labels('db.users.find({}).collation({ locale: "en" }).'), ["limit", "sort", "skip", "explain", "collation", "toArray", "pretty"]);
  assert.deepEqual(labels("db.users.aggregate([])."), ["toArray", "pretty"]);
});

test("completes an index's partial filter as a filter", () => {
  assert.deepEqual(labels("db.users.createIndex({ a: 1 }, { partialFilterExpression: { ", { fields }).slice(0, 3), ["_id", "createdAt", "name"]);
  assert.ok(labels("db.users.createIndex({ a: 1 }, { partialFilterExpression: { name: { $", { fields }).includes("$exists"));
  assert.ok(labels("db.users.createIndex({ a: 1 }, { partialFilterExpression: { name: { $exists: ", { fields }).includes("true"));
});

test("every suggested sub-document key and enumerated value parses in the position that offers it", () => {
  const render = (apply: string) => apply.replace(/\$\{([^{}]*)\}/g, (_, name: string) => name || "1");
  const keyCommands: Record<string, (body: string) => string> = {
    $text: (body) => `db.users.find({ $text: { ${body} } })`,
    $geoWithin: (body) => `db.users.find({ loc: { $geoWithin: { ${body} } } })`,
    $geoIntersects: (body) => `db.users.find({ loc: { $geoIntersects: { ${body} } } })`,
    $near: (body) => `db.users.find({ loc: { $near: { ${body} } } })`,
    $nearSphere: (body) => `db.users.find({ loc: { $nearSphere: { ${body} } } })`,
    $geometry: (body) => `db.users.find({ loc: { $near: { $geometry: { ${body} } } } })`,
    $jsonSchema: (body) => `db.users.find({ $jsonSchema: { ${body} } })`,
    $currentDate: (body) => `db.users.updateOne({}, { $currentDate: { at: { ${body} } } })`,
    collation: (body) => `db.users.find({}).collation({ ${body} })`,
    timeseries: (body) => `db.createCollection("x", { timeseries: { ${body} } })`,
    clusteredIndex: (body) => `db.createCollection("x", { clusteredIndex: { ${body} } })`,
    range: (body) => `db.users.aggregate([{ $densify: { field: "t", range: { ${body} } } }])`,
    fillOutput: (body) => `db.users.aggregate([{ $fill: { output: { score: { ${body} } } } }])`,
  };
  for (const [operator, keys] of Object.entries(OPERATOR_SUB_KEYS)) {
    const build = keyCommands[operator];
    assert.ok(build, `${operator} needs a sample command in this test`);
    for (const key of keys) {
      const command = build(render(key.apply));
      assert.ok(parseMongoCommand(command), `${command} must parse`);
    }
  }

  const valueCommands: Record<string, (value: string) => string> = {
    $type: (value) => `db.users.find({ a: { $type: ${value} } })`,
    $meta: (value) => `db.users.find({}, { score: { $meta: ${value} } })`,
    bsonType: (value) => `db.users.find({ $jsonSchema: { bsonType: ${value} } })`,
    $options: (value) => `db.users.find({ a: { $regex: "x", $options: ${value} } })`,
    geometryType: (value) => `db.users.find({ loc: { $geoIntersects: { $geometry: { type: ${value}, coordinates: [] } } } })`,
    returnDocument: (value) => `db.users.findOneAndUpdate({}, { $set: { a: 1 } }, { returnDocument: ${value} })`,
    explain: (value) => `db.users.find({}).explain(${value})`,
    currentDateType: (value) => `db.users.updateOne({}, { $currentDate: { at: { $type: ${value} } } })`,
    caseFirst: (value) => `db.users.find({}).collation({ locale: "en", caseFirst: ${value} })`,
    alternate: (value) => `db.users.find({}).collation({ locale: "en", alternate: ${value} })`,
    maxVariable: (value) => `db.users.find({}).collation({ locale: "en", maxVariable: ${value} })`,
    strength: (value) => `db.users.find({}).collation({ locale: "en", strength: ${value} })`,
    validationLevel: (value) => `db.createCollection("x", { validationLevel: ${value} })`,
    validationAction: (value) => `db.createCollection("x", { validationAction: ${value} })`,
    granularity: (value) => `db.createCollection("x", { timeseries: { timeField: "t", granularity: ${value} } })`,
    unit: (value) => `db.users.aggregate([{ $densify: { field: "t", range: { step: 1, unit: ${value} } } }])`,
    bounds: (value) => `db.users.aggregate([{ $densify: { field: "t", range: { step: 1, bounds: ${value} } } }])`,
    fillMethod: (value) => `db.users.aggregate([{ $fill: { output: { score: { method: ${value} } } } }])`,
    boolean: (value) => `db.users.find({ a: { $exists: ${value} } })`,
    $regex: (value) => `db.users.find({ a: { $regex: ${value} } })`,
    $language: (value) => `db.users.find({ $text: { $search: "x", $language: ${value} } })`,
    locale: (value) => `db.users.find({}).collation({ locale: ${value} })`,
    whenMatched: (value) => `db.users.aggregate([{ $merge: { into: "out", whenMatched: ${value} } }])`,
    whenNotMatched: (value) => `db.users.aggregate([{ $merge: { into: "out", whenNotMatched: ${value} } }])`,
  };
  for (const [enumKey, values] of Object.entries(ENUM_VALUES)) {
    const build = valueCommands[enumKey];
    assert.ok(build, `${enumKey} needs a sample command in this test`);
    for (const value of values) {
      const command = build(render(value.apply));
      assert.ok(parseMongoCommand(command), `${command} must parse`);
    }
  }
});

test("completes the pipeline form of an update", () => {
  const stages = labels("db.users.updateOne({}, [{ $", { fields });
  assert.deepEqual([...stages].sort(), ["$addFields", "$project", "$replaceRoot", "$replaceWith", "$set", "$unset"]);
  assert.deepEqual(labels("db.users.updateMany({}, [{ $set: { a: 1 } }, { $", { fields }), stages);
  assert.deepEqual(labels("db.users.findOneAndUpdate({}, [{ $", { fields }), stages);
  assert.deepEqual(labels("db.users.bulkWrite([{ updateOne: { filter: {}, update: [{ $", { fields }), stages);
  // Inside a stage the shapes are the aggregation ones.
  assert.deepEqual(labels("db.users.updateOne({}, [{ $set: { ", { fields }), ["_id", "createdAt", "name", "profile.email"]);
  assert.ok(labels("db.users.updateOne({}, [{ $set: { total: { $", { fields }).includes("$add"));
  assert.deepEqual(labels('db.users.updateOne({}, [{ $unset: "', { fields }), ["_id", "createdAt", "name", "profile.email"]);
  assert.ok(labels('db.users.updateOne({}, [{ $replaceWith: "$', { fields }).includes("$name"));
  // The document form is untouched, the array itself waits for a stage object, and the options still follow.
  assert.ok(labels("db.users.updateOne({}, { $", { fields }).includes("$inc"));
  assert.deepEqual(labels("db.users.updateOne({}, [", { fields }), []);
  assert.deepEqual(labels("db.users.updateOne({}, [{ $set: {} }], { ", { fields }), ["arrayFilters", "upsert"]);
});

test("completes createCollection options and the documents inside them", () => {
  const keys = labels('db.createCollection("events", { ');
  for (const key of ["validator", "validationLevel", "capped", "size", "timeseries", "clusteredIndex", "collation", "viewOn", "pipeline"]) assert.ok(keys.includes(key), key);
  // The validator is a filter, so the schema completes inside it.
  assert.ok(labels('db.createCollection("events", { validator: { ', { fields }).includes("$jsonSchema"));
  assert.ok(labels('db.createCollection("events", { validator: { $jsonSchema: { ').includes("required"));
  assert.ok(labels('db.createCollection("events", { validator: { $jsonSchema: { properties: { name: { bsonType: "').includes("string"));
  assert.deepEqual(labels('db.createCollection("events", { validationLevel: "'), ["strict", "moderate", "off"]);
  assert.deepEqual(labels('db.createCollection("events", { validationAction: "'), ["error", "warn"]);
  assert.deepEqual(labels('db.createCollection("events", { timeseries: { '), ["bucketMaxSpanSeconds", "bucketRoundingSeconds", "granularity", "metaField", "timeField"]);
  assert.deepEqual(labels('db.createCollection("events", { timeseries: { granularity: "'), ["seconds", "minutes", "hours"]);
  assert.deepEqual(labels('db.createCollection("events", { clusteredIndex: { '), ["key", "name", "unique"]);
  assert.ok(labels('db.createCollection("events", { collation: { ').includes("locale"));
  assert.deepEqual(labels('db.createCollection("v", { viewOn: "', { collections }), collections);
  assert.ok(labels('db.createCollection("v", { viewOn: "users", pipeline: [{ $').includes("$match"));
  assert.ok(labels('db.createCollection("v", { pipeline: [{ $match: { ', { fields }).includes("name"));
  // The name argument is the user's own.
  assert.deepEqual(labels('db.createCollection("'), []);
});

test("completes runCommand command names and their collection arguments", () => {
  const commands = labels("db.runCommand({ ");
  for (const command of ["ping", "hello", "serverStatus", "dbStats", "collStats", "find", "aggregate", "listCollections", "createIndexes"]) assert.ok(commands.includes(command), command);
  assert.deepEqual(labels("db.runCommand({ collSt"), ["collStats"]);
  assert.deepEqual(labels('db.runCommand({ collStats: "', { collections }), collections);
  assert.deepEqual(labels('db.runCommand({ find: "us', { collections }), ["users", "user_events"]);
  assert.deepEqual(labels('db.runCommand({ ping: "', { collections }), []);
  // A second key still completes commands, and `db.` offers the helper.
  assert.ok(labels('db.runCommand({ find: "users", ').includes("find"));
  assert.ok(labels("db.").includes("runCommand"));
});

test("every suggested createCollection option, createUser option and runCommand command parses", () => {
  const render = (apply: string) => apply.replace(/\$\{([^{}]*)\}/g, (_, name: string) => name || "1");
  for (const option of METHOD_OPTION_KEYS.createCollection ?? []) {
    const command = `db.createCollection("x", { ${render(option.apply)} })`;
    assert.ok(parseMongoCommand(command), `${command} must parse`);
  }
  for (const spec of METHOD_OPTION_KEYS.runCommand ?? []) {
    const command = `db.runCommand({ ${render(spec.apply)} })`;
    assert.ok(parseMongoCommand(command), `${command} must parse`);
  }
  for (const option of METHOD_OPTION_KEYS.createUser ?? []) {
    const command = `db.createUser({ ${option.label === "user" ? "" : 'user: "test", '}${render(option.apply)} })`;
    assert.ok(parseMongoCommand(command), `${command} must parse`);
  }
});

test("suggests the use and db.version commands", () => {
  assert.equal(buildMongoCompletionItems("us", 2).find((item) => item.label === "use")?.apply, "use ${database}");
  // Database helpers stay reachable after `db.`, alongside the collection names.
  assert.ok(labels("db.vers", { collections }).includes("version"));
  assert.equal(labels("db.getColl", { collections }).includes("getCollection"), true);
});

test("suggests show dbs and show subcommands", () => {
  // Typing sh or show at root offers show dbs snippet
  const shItems = buildMongoCompletionItems("sh", 2);
  const showSnippet = shItems.find((item) => item.label === "show dbs");
  assert.ok(showSnippet, "typing sh offers show dbs");
  assert.equal(showSnippet?.apply, "show dbs");
  assert.ok(buildMongoCompletionItems("show", 4).some((item) => item.label === "show dbs"));
  assert.ok(parseMongoCommand("show dbs"), "show dbs snippet must parse");

  // show followed by space offers dbs and databases, and NOT db.* snippets
  const showSpaceItems = labels("show ");
  assert.deepEqual(showSpaceItems, ["dbs", "databases"]);
  assert.equal(showSpaceItems.includes("db.collection.find"), false);
  assert.equal(showSpaceItems.includes("db.version"), false);
  assert.equal(showSpaceItems.includes("collections"), false, "show collections is not supported");

  // Subcommand filtering
  assert.deepEqual(labels("show d"), ["dbs", "databases"]);
  assert.deepEqual(labels("show db"), ["dbs"]);
  assert.deepEqual(labels("show dat"), ["databases"]);
  assert.deepEqual(labels("show col"), []);

  // Context and auto-trigger
  assert.deepEqual(getMongoCompletionContext("show ", 5), { mode: "showSubcommand", prefix: "", from: 5 });
  assert.deepEqual(getMongoCompletionContext("show db", 7), { mode: "showSubcommand", prefix: "db", from: 5 });
  assert.equal(shouldAutoOpenMongoCompletion("show ", 5), true);

  // Stays quiet when extra arguments follow rather than leaking root snippets
  assert.deepEqual(labels("show dbs extra"), []);

  // Subsequent lines in scripts without semicolons retain root and db completions
  assert.ok(labels("show dbs\nfi").includes("find"));
  assert.ok(labels("show dbs\ndb.", { collections }).includes("users"));
  assert.ok(labels("show dbs\ndb.", { collections }).includes("version"));
  assert.ok(labels("show dbs\nsh").includes("show dbs"));
});

test("suggests createUser database helper and its document options", () => {
  // Offered on db. alongside other database helpers
  const dbHelpers = labels("db.");
  assert.ok(dbHelpers.includes("createUser"));
  const snippet = buildMongoCompletionItems("db.createU", "db.createU".length).find((item) => item.label === "createUser");
  assert.equal(snippet?.apply, 'createUser({ user: "${name}", pwd: "${password}", roles: [] })');

  // Document argument options
  const optionLabels = labels("db.createUser({ ");
  assert.deepEqual(optionLabels, ["customData", "mechanisms", "pwd", "roles", "user"]);
  assert.deepEqual(labels("db.createUser({ pw"), ["pwd"]);

  // Stays quiet inside sub-arrays/values rather than leaking root snippets
  assert.deepEqual(labels("db.createUser({ roles: [ "), []);

  // Snippet parses via parseMongoCommand
  assert.ok(parseMongoCommand('db.createUser({ user: "name", pwd: "password", roles: [] })'));
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
  const templates = [
    ...QUERY_OPERATORS,
    ...UPDATE_OPERATORS,
    ...PUSH_MODIFIERS,
    ...PROJECTION_OPERATORS,
    ...PIPELINE_STAGES,
    ...ACCUMULATORS,
    ...WINDOW_OPERATORS,
    ...EXPRESSION_OPERATORS,
    ...VALUE_SNIPPETS,
    ...EXTENDED_JSON_VALUES,
    ...Object.values(STAGE_OPTION_KEYS).flat(),
    ...Object.values(OPERATOR_SUB_KEYS).flat(),
    ...Object.values(ENUM_VALUES).flat(),
  ];
  assert.ok(templates.length > 200);

  for (const { label, apply } of templates) {
    // `${10}` reads as tab stop number 10 with no text, so the default is silently
    // dropped on accept. Numeric defaults have to be written literally.
    assert.equal(/\$\{\d+\}/.test(apply), false, `${label} has a numeric placeholder that would insert nothing: ${apply}`);
    // Placeholder names cannot nest braces — the parser stops at the first `}`.
    assert.equal(/\$\{[^{}]*\{/.test(apply), false, `${label} has a nested brace in a placeholder: ${apply}`);
  }
});

test("treats extended JSON wrappers as scalars, not subdocuments", () => {
  // The driver ships BSON scalars as extended JSON. Walking into them would offer
  // `_id.$oid`, which is valid syntax that matches nothing on the server.
  const inferred = inferMongoCompletionFields([
    {
      _id: { $oid: "6743e4bfa3f6f84bc3fff6c8" },
      created_at: { $date: "2025-01-01T00:00:00Z" },
      count: { $numberLong: "42" },
      raw: { $binary: { base64: "AQID", subType: "00" } },
      profile: { email: "a@example.com" },
    },
  ]);

  for (const phantom of ["_id.$oid", "created_at.$date", "count.$numberLong", "raw.$binary"]) {
    assert.equal(
      inferred.some((field) => field.name === phantom),
      false,
      phantom,
    );
  }

  assert.ok(inferred.find((field) => field.name === "_id" && field.type === "objectId"));
  assert.ok(inferred.find((field) => field.name === "created_at" && field.type === "date"));
  assert.ok(inferred.find((field) => field.name === "count" && field.type === "int64"));
  assert.ok(inferred.find((field) => field.name === "raw" && field.type === "binary"));
  // Genuine subdocuments are still walked.
  assert.ok(inferred.find((field) => field.name === "profile.email" && field.type === "string"));
});

test("infers BSON types from extended JSON values and legacy ISODate strings", () => {
  const inferred = inferMongoCompletionFields([
    {
      createdAt: { $date: "2026-01-01T00:00:00Z" },
      ref: { $oid: "65f0c0ffee0000000000abcd" },
      price: { $numberDecimal: "1.5" },
    },
  ]);

  for (const phantom of ["createdAt.$date", "ref.$oid", "price.$numberDecimal"]) {
    assert.equal(
      inferred.some((field) => field.name === phantom),
      false,
      phantom,
    );
  }

  assert.equal(inferred.find((field) => field.name === "createdAt")?.type, "date");
  assert.equal(inferred.find((field) => field.name === "ref")?.type, "objectId");
  assert.equal(inferred.find((field) => field.name === "price")?.type, "decimal128");

  const legacyInferred = inferMongoCompletionFields([
    {
      createdAt: 'ISODate("2026-01-01T00:00:00Z")',
    },
  ]);
  assert.equal(legacyInferred.find((field) => field.name === "createdAt")?.type, "date");
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

test("infers MongoDB fields from up to 10 array elements and ignores later elements", () => {
  const documents = [
    {
      items: [{ e0: 0 }, { e1: 1 }, { e2: 2 }, { e3: 3 }, { e4: 4 }, { e5: 5 }, { e6: 6 }, { e7: 7 }, { e8: 8 }, { e9: 9 }, { e10: 10 }, { e11: 11 }],
    },
  ];

  const inferred = inferMongoCompletionFields(documents);

  // Array path itself
  assert.ok(inferred.find((field) => field.name === "items" && field.type === "array"));
  // Elements 0 through 9 (first 10 elements) must be sampled
  assert.ok(inferred.find((field) => field.name === "items.e0" && field.type === "number"));
  assert.ok(inferred.find((field) => field.name === "items.e2" && field.type === "number"));
  assert.ok(inferred.find((field) => field.name === "items.e3" && field.type === "number"));
  assert.ok(inferred.find((field) => field.name === "items.e9" && field.type === "number"));
  // Elements 10 and 11 (beyond the 10-element limit) must NOT be sampled
  assert.equal(
    inferred.some((field) => field.name === "items.e10"),
    false,
  );
  assert.equal(
    inferred.some((field) => field.name === "items.e11"),
    false,
  );
});

test("caps inferred MongoDB distinct field paths at 512", () => {
  const pathologicalDoc: Record<string, number> = {};
  for (let i = 0; i < 600; i++) {
    pathologicalDoc[`field_${i.toString().padStart(4, "0")}`] = i;
  }

  const inferred = inferMongoCompletionFields([pathologicalDoc]);
  assert.equal(inferred.length, 512);

  // A second document with existing and new fields: existing fields update types, new fields are ignored
  const secondDoc: Record<string, unknown> = {
    field_0000: "string_value",
    brand_new_overflow_field: 42,
  };
  const inferredWithSecond = inferMongoCompletionFields([pathologicalDoc, secondDoc]);
  assert.equal(inferredWithSecond.length, 512);
  assert.equal(inferredWithSecond.find((field) => field.name === "field_0000")?.type, "number | string");
  assert.equal(
    inferredWithSecond.some((field) => field.name === "brand_new_overflow_field"),
    false,
  );
});

test("completes $setWindowFields stage options, sortBy key map, and output window operators", () => {
  assert.deepEqual(labels("db.users.aggregate([{ $setWindowFields: { "), ["output", "partitionBy", "sortBy"]);
  assert.deepEqual(labels("db.users.aggregate([{ $setWindowFields: { partitionBy: '", { fields }), ["$_id", "$createdAt", "$name", "$profile.email"]);
  assert.deepEqual(labels("db.users.aggregate([{ $setWindowFields: { sortBy: { ", { fields }), ["_id", "createdAt", "name", "profile.email"]);
  assert.deepEqual(labels("db.users.aggregate([{ $setWindowFields: { sortBy: { name: ", { fields }), ["-1", "1"]);
  assert.deepEqual(labels("db.users.aggregate([{ $setWindowFields: { output: { ", { fields }), ["_id", "createdAt", "name", "profile.email"]);

  const windowOps = labels("db.users.aggregate([{ $setWindowFields: { output: { r: { $");
  const expectedOperators = [
    "$rank",
    "$denseRank",
    "$documentNumber",
    "$shift",
    "$expMovingAvg",
    "$derivative",
    "$integral",
    "$covariancePop",
    "$covarianceSamp",
    "$locf",
    "$linearFill",
    "$sum",
    "$avg",
    "$min",
    "$max",
    "$count",
    "$first",
    "$last",
    "$push",
    "$addToSet",
    "$stdDevPop",
    "$stdDevSamp",
    "$top",
    "$bottom",
    "$topN",
    "$bottomN",
    "$firstN",
    "$lastN",
    "$maxN",
    "$minN",
    "$median",
    "$percentile",
  ];
  for (const op of expectedOperators) {
    assert.ok(windowOps.includes(op), op);
  }
  assert.equal(windowOps.includes("window"), false);

  const bareOutputBody = labels("db.users.aggregate([{ $setWindowFields: { output: { r: { ");
  assert.ok(bareOutputBody.includes("window"));
  assert.ok(bareOutputBody.includes("$rank"));

  const windowPrefix = labels("db.users.aggregate([{ $setWindowFields: { output: { r: { win");
  assert.ok(windowPrefix.includes("window"));
});

test("completes $densify and $fill stage options and value modes", () => {
  assert.deepEqual(labels("db.users.aggregate([{ $densify: { "), ["field", "partitionByFields", "range"]);
  assert.deepEqual(labels("db.users.aggregate([{ $densify: { field: '", { fields }), ["_id", "createdAt", "name", "profile.email"]);
  assert.deepEqual(labels("db.users.aggregate([{ $densify: { partitionByFields: ['", { fields }), ["_id", "createdAt", "name", "profile.email"]);
  assert.deepEqual(labels("db.users.aggregate([{ $densify: { range: { "), ["bounds", "step", "unit"]);
  assert.ok(labels("db.users.aggregate([{ $densify: { range: { unit: '").includes("hour"));
  assert.ok(labels("db.users.aggregate([{ $densify: { range: { bounds: '").includes("full"));

  assert.deepEqual(labels("db.users.aggregate([{ $fill: { "), ["output", "partitionBy", "partitionByFields", "sortBy"]);
  assert.deepEqual(labels("db.users.aggregate([{ $fill: { partitionBy: '", { fields }), ["$_id", "$createdAt", "$name", "$profile.email"]);
  assert.deepEqual(labels("db.users.aggregate([{ $fill: { partitionByFields: ['", { fields }), ["_id", "createdAt", "name", "profile.email"]);
  assert.deepEqual(labels("db.users.aggregate([{ $fill: { sortBy: { ", { fields }), ["_id", "createdAt", "name", "profile.email"]);
  assert.deepEqual(labels("db.users.aggregate([{ $fill: { sortBy: { name: ", { fields }), ["-1", "1"]);
  assert.deepEqual(labels("db.users.aggregate([{ $fill: { output: { ", { fields }), ["_id", "createdAt", "name", "profile.email"]);
  assert.deepEqual(labels("db.users.aggregate([{ $fill: { output: { amount: { "), ["method", "value"]);
  assert.deepEqual(labels("db.users.aggregate([{ $fill: { output: { amount: { method: '"), ["linear", "locf"]);
  assert.deepEqual(labels("db.users.aggregate([{ $fill: { output: { amount: { value: '", { fields }), ["$_id", "$createdAt", "$name", "$profile.email"]);
});

test("completes joined-collection fields inside $lookup, $graphLookup and $unionWith", () => {
  // $lookup foreignField targets joined collection
  const lookupForeign = getMongoCompletionContext('db.users.aggregate([{ $lookup: { from: "orders", localField: "name", foreignField: "', 'db.users.aggregate([{ $lookup: { from: "orders", localField: "name", foreignField: "'.length);
  assert.equal(lookupForeign.collection, "orders");
  assert.equal(lookupForeign.mode, "fieldPath");

  // $lookup sub-pipeline runs over joined collection
  const lookupPipelineMatch = getMongoCompletionContext('db.users.aggregate([{ $lookup: { from: "orders", pipeline: [{ $match: { ', 'db.users.aggregate([{ $lookup: { from: "orders", pipeline: [{ $match: { '.length);
  assert.equal(lookupPipelineMatch.collection, "orders");
  assert.equal(lookupPipelineMatch.mode, "filterField");

  const lookupPipelineProject = getMongoCompletionContext('db.users.aggregate([{ $lookup: { from: "orders", pipeline: [{ $project: { ', 'db.users.aggregate([{ $lookup: { from: "orders", pipeline: [{ $project: { '.length);
  assert.equal(lookupPipelineProject.collection, "orders");
  assert.equal(lookupPipelineProject.mode, "field");

  // $graphLookup connectToField and connectFromField target joined collection
  const graphConnectTo = getMongoCompletionContext('db.users.aggregate([{ $graphLookup: { from: "orders", connectToField: "', 'db.users.aggregate([{ $graphLookup: { from: "orders", connectToField: "'.length);
  assert.equal(graphConnectTo.collection, "orders");
  assert.equal(graphConnectTo.mode, "fieldPath");

  const graphConnectFrom = getMongoCompletionContext('db.users.aggregate([{ $graphLookup: { from: "orders", connectFromField: "', 'db.users.aggregate([{ $graphLookup: { from: "orders", connectFromField: "'.length);
  assert.equal(graphConnectFrom.collection, "orders");
  assert.equal(graphConnectFrom.mode, "fieldPath");

  // $graphLookup restrictSearchWithMatch targets joined collection
  const graphRestrict = getMongoCompletionContext('db.users.aggregate([{ $graphLookup: { from: "orders", restrictSearchWithMatch: { ', 'db.users.aggregate([{ $graphLookup: { from: "orders", restrictSearchWithMatch: { '.length);
  assert.equal(graphRestrict.collection, "orders");
  assert.equal(graphRestrict.mode, "filterField");

  // $unionWith sub-pipeline runs over joined collection
  const unionPipelineMatch = getMongoCompletionContext('db.users.aggregate([{ $unionWith: { coll: "orders", pipeline: [{ $match: { ', 'db.users.aggregate([{ $unionWith: { coll: "orders", pipeline: [{ $match: { '.length);
  assert.equal(unionPipelineMatch.collection, "orders");
  assert.equal(unionPipelineMatch.mode, "filterField");
});

test("keeps localField and startWith on outer collection at top level", () => {
  const lookupLocal = getMongoCompletionContext('db.users.aggregate([{ $lookup: { from: "orders", localField: "', 'db.users.aggregate([{ $lookup: { from: "orders", localField: "'.length);
  assert.equal(lookupLocal.collection, "users");
  assert.equal(lookupLocal.mode, "fieldPath");

  const graphStartWith = getMongoCompletionContext('db.users.aggregate([{ $graphLookup: { from: "orders", startWith: "', 'db.users.aggregate([{ $graphLookup: { from: "orders", startWith: "'.length);
  assert.equal(graphStartWith.collection, "users");
  assert.equal(graphStartWith.mode, "fieldRef");
});

test("resolves collections for nested join stages inside a sub-pipeline", () => {
  const nestedLookupForeign = getMongoCompletionContext('db.users.aggregate([{ $lookup: { from: "orders", pipeline: [{ $lookup: { from: "items", foreignField: "', 'db.users.aggregate([{ $lookup: { from: "orders", pipeline: [{ $lookup: { from: "items", foreignField: "'.length);
  assert.equal(nestedLookupForeign.collection, "items");

  const nestedSubPipeline = getMongoCompletionContext('db.users.aggregate([{ $lookup: { from: "orders", pipeline: [{ $lookup: { from: "items", pipeline: [{ $match: { ', 'db.users.aggregate([{ $lookup: { from: "orders", pipeline: [{ $lookup: { from: "items", pipeline: [{ $match: { '.length);
  assert.equal(nestedSubPipeline.collection, "items");

  // Nested localField and startWith resolve to the enclosing sub-pipeline's input collection
  const nestedLocalField = getMongoCompletionContext('db.users.aggregate([{ $lookup: { from: "orders", pipeline: [{ $lookup: { from: "items", localField: "', 'db.users.aggregate([{ $lookup: { from: "orders", pipeline: [{ $lookup: { from: "items", localField: "'.length);
  assert.equal(nestedLocalField.collection, "orders");

  const nestedStartWith = getMongoCompletionContext('db.users.aggregate([{ $lookup: { from: "orders", pipeline: [{ $graphLookup: { from: "items", startWith: "', 'db.users.aggregate([{ $lookup: { from: "orders", pipeline: [{ $graphLookup: { from: "items", startWith: "'.length);
  assert.equal(nestedStartWith.collection, "orders");

  // Nested $lookup with no from typed yet falls back to sub-pipeline input
  const nestedMissingFrom = getMongoCompletionContext('db.users.aggregate([{ $lookup: { from: "orders", pipeline: [{ $lookup: { foreignField: "', 'db.users.aggregate([{ $lookup: { from: "orders", pipeline: [{ $lookup: { foreignField: "'.length);
  assert.equal(nestedMissingFrom.collection, "orders");
});

test("falls back to outer collection when from or coll is missing or untyped at top level", () => {
  const missingFromLookup = getMongoCompletionContext('db.users.aggregate([{ $lookup: { foreignField: "', 'db.users.aggregate([{ $lookup: { foreignField: "'.length);
  assert.equal(missingFromLookup.collection, "users");

  const missingCollUnion = getMongoCompletionContext("db.users.aggregate([{ $unionWith: { pipeline: [{ $match: { ", "db.users.aggregate([{ $unionWith: { pipeline: [{ $match: { ".length);
  assert.equal(missingCollUnion.collection, "users");

  const fromAfterCursor = getMongoCompletionContext('db.users.aggregate([{ $lookup: { foreignField: " }, from: "orders" }])', 'db.users.aggregate([{ $lookup: { foreignField: "'.length);
  assert.equal(fromAfterCursor.collection, "users");
});

test("handles from values containing commas or braces without confusing scan", () => {
  const commaFrom = getMongoCompletionContext('db.users.aggregate([{ $lookup: { from: "orders,archive", foreignField: "', 'db.users.aggregate([{ $lookup: { from: "orders,archive", foreignField: "'.length);
  assert.equal(commaFrom.collection, "orders,archive");

  const braceFrom = getMongoCompletionContext('db.users.aggregate([{ $lookup: { from: "orders{2024}", foreignField: "', 'db.users.aggregate([{ $lookup: { from: "orders{2024}", foreignField: "'.length);
  assert.equal(braceFrom.collection, "orders{2024}");
});

// A `db.other.` inside a string or a comment is literal content. Reading it as the command under
// the cursor loads the wrong collection's fields, and — when the literal happens to be preceded
// by a space — even swaps the whole method list to that collection.
test("reads the active collection from code, not from string or comment contents", () => {
  const comment = "db.users.find({ /* db.orders. */ na";
  const string = 'db.users.find({ note: "db.orders." }, na';
  const singleQuoted = "db.users.find({ note: 'db.orders.' , na";

  assert.equal(getMongoCompletionContext(comment, comment.length).collection, "users");
  assert.equal(getMongoCompletionContext(string, string.length).collection, "users");
  assert.equal(getMongoCompletionContext(singleQuoted, singleQuoted.length).collection, "users");

  // An unterminated string whose contents start with a space must not look like a `db.` root.
  for (const text of ['db.users.find({ note: " db.orders.', "db.users.find({ note: ' x db.orders.", 'db.users.find({ a: "x" }, { b: " db.orders.']) {
    const context = getMongoCompletionContext(text, text.length);
    assert.equal(context.collection, "users", text);
    assert.notEqual(context.mode, "collectionOrMethod", text);
    assert.deepEqual(labels(text, { collections }), [], text);
  }

  // A quoted name in a real root still resolves, even though the same regexes match it.
  const dotted = 'db.getCollection("audit.logs").find({ na';
  const sibling = 'db.getSiblingDB("analytics").users.find({ na';
  assert.equal(getMongoCompletionContext(dotted, dotted.length).collection, "audit.logs");
  assert.equal(getMongoCompletionContext(sibling, sibling.length).collection, "users");
});

// `findMatchingParen` walks the find() chain, so a comment in the arguments must not unbalance it:
// an unmatched parenthesis in a comment there used to hide the call's own `)`.
test("keeps the find chain completable when a comment holds an unbalanced parenthesis", () => {
  const open = "db.users.find({ /* ( */ status: 1 }).li";
  const close = "db.users.find({ /* ) */ status: 1 }).li";
  const balanced = "db.users.find({ /* (legacy) */ status: 1 }).li";
  const lineComment = "db.users.find({\n  // filter by (legacy) status\n  status: 1\n}).li";

  assert.equal(getMongoCompletionContext(open, open.length).mode, "cursorMethod");
  assert.equal(getMongoCompletionContext(close, close.length).mode, "cursorMethod");
  assert.deepEqual(labels(open, { fields }), ["limit"]);
  assert.deepEqual(labels(close, { fields }), ["limit"]);
  // Balanced parentheses, line comments and strings were already handled; keep them working.
  assert.deepEqual(labels(balanced, { fields }), ["limit"]);
  assert.deepEqual(labels(lineComment, { fields }), ["limit"]);
  assert.deepEqual(labels('db.users.find({ note: "(x" }).li', { fields }), ["limit"]);
});

test("completes bracket collection references db['name'] and db[\"name\"]", () => {
  // Case 1: db["orders-2024"]. -> method mode, collection methods
  const afterBracketDot = 'db["orders-2024"].';
  const ctx1 = getMongoCompletionContext(afterBracketDot, afterBracketDot.length);
  assert.equal(ctx1.mode, "method");
  assert.equal(ctx1.collection, "orders-2024");
  const labels1 = labels(afterBracketDot);
  assert.ok(labels1.includes("find"));
  assert.ok(labels1.includes("findOne"));
  assert.ok(labels1.includes("aggregate"));

  // Case 2: db['users'].fi (single quotes, prefix) -> method mode, filtered collection methods
  const prefixedSingleQuote = "db['users'].fi";
  const ctx2 = getMongoCompletionContext(prefixedSingleQuote, prefixedSingleQuote.length);
  assert.equal(ctx2.mode, "method");
  assert.equal(ctx2.collection, "users");
  assert.equal(ctx2.prefix, "fi");
  const labels2 = labels(prefixedSingleQuote);
  assert.ok(labels2.includes("find"));
  assert.ok(labels2.includes("findOne"));
  assert.ok(labels2.includes("findOneAndUpdate"));
  assert.equal(labels2.includes("db.collection.find"), false);

  // Case 3: db["orders-2024"].find({ -> filterField mode, collection resolved for field completion
  const findFilter = 'db["orders-2024"].find({';
  const ctx3 = getMongoCompletionContext(findFilter, findFilter.length);
  assert.equal(ctx3.mode, "filterField");
  assert.equal(ctx3.collection, "orders-2024");
  const labels3 = labels(findFilter, { fields });
  assert.ok(labels3.includes("name"));
  assert.ok(labels3.includes("createdAt"));

  // Case 4: db["orders-2024"].find({}). -> cursor methods
  const cursorChain = 'db["orders-2024"].find({}).';
  const ctx4 = getMongoCompletionContext(cursorChain, cursorChain.length);
  assert.equal(ctx4.mode, "cursorMethod");
  assert.equal(ctx4.collection, "orders-2024");
  const labels4 = labels(cursorChain);
  assert.ok(labels4.includes("limit"));
  assert.ok(labels4.includes("sort"));
  assert.ok(labels4.includes("skip"));
  assert.ok(labels4.includes("count"));
  assert.ok(labels4.includes("toArray"));

  // Case 5: db["orders-2024"].aggregate([{ $ -> aggregation stages with active collection
  const aggStage = 'db["orders-2024"].aggregate([{ $';
  const ctx5 = getMongoCompletionContext(aggStage, aggStage.length);
  assert.equal(ctx5.mode, "stage");
  assert.equal(ctx5.collection, "orders-2024");
  const labels5 = labels(aggStage);
  assert.ok(labels5.includes("$match"));
  assert.ok(labels5.includes("$group"));
  assert.ok(labels5.includes("$project"));

  // Case 6: db[" -> collectionRef mode, quoted collection names
  const bracketOpen = 'db["';
  const ctx6 = getMongoCompletionContext(bracketOpen, bracketOpen.length);
  assert.equal(ctx6.mode, "collectionRef");
  assert.equal(ctx6.prefix, '"');
  const items6 = buildMongoCompletionItems(bracketOpen, bracketOpen.length, { collections });
  assert.ok(items6.some((item) => item.label === "users" && item.apply === '"users"'));
  assert.ok(items6.some((item) => item.label === "order-items" && item.apply === '"order-items"'));

  // Case 6b: db[""] with cursor between quotes consumes closing quote
  const textQuoted = 'db[""]';
  const cursorQuoted = textQuoted.indexOf('""') + 1;
  const ctxQuoted = getMongoCompletionContext(textQuoted, cursorQuoted);
  assert.equal(ctxQuoted.mode, "collectionRef");
  assert.equal(ctxQuoted.replaceClosingQuote, '"');
  const itemQuoted = buildMongoCompletionItems(textQuoted, cursorQuoted, { collections }).find((c) => c.label === "users");
  assert.equal(itemQuoted?.replaceClosingQuote, '"');

  // Case 7 & 8: Name containing '.' and '-' with both quote styles
  const dottedName = "db['audit.logs'].find({";
  const ctxDot = getMongoCompletionContext(dottedName, dottedName.length);
  assert.equal(ctxDot.mode, "filterField");
  assert.equal(ctxDot.collection, "audit.logs");
  const dottedMethod = "db['audit.logs'].";
  const ctxDotMethod = getMongoCompletionContext(dottedMethod, dottedMethod.length);
  assert.equal(ctxDotMethod.mode, "method");
  assert.equal(ctxDotMethod.collection, "audit.logs");
  assert.ok(labels(dottedMethod).includes("find"));

  // Case 9: db.getSiblingDB("shop")["orders"].find({ -> database "shop", collection "orders"
  const siblingText = 'db.getSiblingDB("shop")["orders"].find({';
  const ctxSibling = getMongoCompletionContext(siblingText, siblingText.length);
  assert.equal(ctxSibling.mode, "filterField");
  assert.equal(ctxSibling.collection, "orders");
  assert.equal(ctxSibling.database, "shop");

  const siblingMethod = 'db.getSiblingDB("shop")["orders"].';
  const ctxSiblingMethod = getMongoCompletionContext(siblingMethod, siblingMethod.length);
  assert.equal(ctxSiblingMethod.mode, "method");
  assert.equal(ctxSiblingMethod.collection, "orders");
  assert.equal(ctxSiblingMethod.database, "shop");
  assert.ok(labels(siblingMethod).includes("find"));
});

test("suppresses completion after a dot following findOne", () => {
  const text = "db.users.findOne({}).";
  const context = getMongoCompletionContext(text, text.length);
  assert.equal(context.mode, "none");
  assert.deepEqual(labels(text, { collections, fields }), []);
  assert.equal(shouldAutoOpenMongoCompletion(text, text.length), false);
});

test("suppresses completion after a dot following countDocuments", () => {
  const text = "db.users.countDocuments({}).";
  const context = getMongoCompletionContext(text, text.length);
  assert.equal(context.mode, "none");
  assert.deepEqual(labels(text, { collections, fields }), []);
  assert.equal(shouldAutoOpenMongoCompletion(text, text.length), false);
});

test("suppresses completion after a dot following explain", () => {
  const text = "db.users.explain().";
  const context = getMongoCompletionContext(text, text.length);
  assert.equal(context.mode, "none");
  assert.deepEqual(labels(text, { collections, fields }), []);
  assert.equal(shouldAutoOpenMongoCompletion(text, text.length), false);
});

test("suppresses completion after a dot and typed prefix following findOne", () => {
  const text = "db.users.findOne({}).na";
  const context = getMongoCompletionContext(text, text.length);
  assert.equal(context.mode, "none");
  assert.deepEqual(labels(text, { collections, fields }), []);
});

test("suppresses completion after a dot following a non-cursor call with masked parens in literals", () => {
  for (const text of ['db.users.findOne({ note: "(x)" }).', "db.users.findOne({ /* ) */ }).", "db.users.findOne({}) ."]) {
    const context = getMongoCompletionContext(text, text.length);
    assert.equal(context.mode, "none", text);
    assert.deepEqual(labels(text, { collections, fields }), [], text);
    assert.equal(shouldAutoOpenMongoCompletion(text, text.length), false, text);
  }
  const typed = "db.users.findOne({}) .na";
  assert.equal(getMongoCompletionContext(typed, typed.length).mode, "none");
  assert.deepEqual(labels(typed, { collections, fields }), []);
});

test("preserves completion behavior for cursor chains, root triggers, and multiline statements", () => {
  // cursor methods
  assert.equal(getMongoCompletionContext("db.users.find({}).", "db.users.find({}).".length).mode, "cursorMethod");
  assert.ok(labels("db.users.find({}).", { fields }).includes("sort"));

  assert.equal(getMongoCompletionContext("db.users.find({}).sort({ name: 1 }).", "db.users.find({}).sort({ name: 1 }).".length).mode, "cursorMethod");
  assert.ok(labels("db.users.find({}).sort({ name: 1 }).", { fields }).includes("limit"));

  // aggregate cursor methods
  assert.equal(getMongoCompletionContext("db.users.aggregate([]).", "db.users.aggregate([]).".length).mode, "cursorMethod");
  assert.deepEqual(labels("db.users.aggregate([]).").sort(), ["pretty", "toArray"]);

  // terminal cursor method count()
  assert.equal(getMongoCompletionContext("db.users.find({}).count().", "db.users.find({}).count().".length).mode, "none");
  assert.deepEqual(labels("db.users.find({}).count()."), []);

  // db root dot / collection prefix / use / show / sh / empty doc
  assert.equal(getMongoCompletionContext("db.", "db.".length).mode, "collection");
  assert.ok(labels("db.", { collections }).includes("users"));

  assert.equal(getMongoCompletionContext("db.us", "db.us".length).mode, "collection");
  assert.ok(labels("db.us", { collections }).includes("users"));
  assert.ok(labels("db.us", { collections }).includes("user_events"));

  assert.equal(getMongoCompletionContext("use ", "use ".length).mode, "database");
  assert.equal(getMongoCompletionContext("show ", "show ".length).mode, "showSubcommand");
  assert.equal(getMongoCompletionContext("sh", "sh".length).mode, "root");
  assert.equal(getMongoCompletionContext("", 0).mode, "root");

  assert.equal(getMongoCompletionContext("db.users.find({ name: 'x' });\ndb.", "db.users.find({ name: 'x' });\ndb.".length).mode, "collection");
  assert.ok(labels("db.users.find({ name: 'x' });\ndb.", { collections }).includes("users"));

  // statement on a new line after a finished statement
  assert.equal(getMongoCompletionContext("db.users.findOne({})\ndb.", "db.users.findOne({})\ndb.".length).mode, "collection");
  assert.ok(labels("db.users.findOne({})\ndb.", { collections }).includes("users"));

  assert.equal(getMongoCompletionContext("db.users.findOne({})\nfi", "db.users.findOne({})\nfi".length).mode, "root");
  assert.ok(labels("db.users.findOne({})\nfi").includes("find"));
});

test("preserves auto-trigger and completion for getCollection and getSiblingDB dot chains", () => {
  const getCollectionDot = 'db.getCollection("users").';
  assert.equal(getMongoCompletionContext(getCollectionDot, getCollectionDot.length).mode, "method");
  assert.equal(shouldAutoOpenMongoCompletion(getCollectionDot, getCollectionDot.length), true);

  const siblingDbDot = 'db.getSiblingDB("shop").';
  assert.equal(getMongoCompletionContext(siblingDbDot, siblingDbDot.length).mode, "collection");
  assert.equal(shouldAutoOpenMongoCompletion(siblingDbDot, siblingDbDot.length), true);

  const siblingGetCollectionDot = 'db.getSiblingDB("shop").getCollection("a").';
  assert.equal(getMongoCompletionContext(siblingGetCollectionDot, siblingGetCollectionDot.length).mode, "method");
  assert.equal(shouldAutoOpenMongoCompletion(siblingGetCollectionDot, siblingGetCollectionDot.length), true);
});
