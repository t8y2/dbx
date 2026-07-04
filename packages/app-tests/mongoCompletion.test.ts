import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildMongoCompletionItems, getMongoCompletionContext, inferMongoCompletionFields, shouldAutoOpenMongoCompletion } from "../../apps/desktop/src/lib/mongoCompletion.ts";

const collections = ["users", "user_events", "order-items"];
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
    assert.equal(items.some((item) => item.label === "SELECT"), false);
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
    assert.equal(item?.apply, "stats()");
});

test("suggests cursor methods after find result chains", () => {
    const allItems = buildMongoCompletionItems("db.characters.find({}).", "db.characters.find({}).".length);
    const prefixedItems = buildMongoCompletionItems("db.characters.find({}).li", "db.characters.find({}).li".length);
    const formattedChainItems = buildMongoCompletionItems("db.characters.find({\n  name: 'Ada'\n})\n  .", "db.characters.find({\n  name: 'Ada'\n})\n  .".length);
    const formattedPrefixedItems = buildMongoCompletionItems("db.characters.find({\n  name: 'Ada'\n})\n  .li", "db.characters.find({\n  name: 'Ada'\n})\n  .li".length);

    assert.deepEqual(
        allItems.map((item) => item.label),
        ["limit", "skip", "sort"],
    );
    assert.deepEqual(
        prefixedItems.map((item) => item.label),
        ["limit"],
    );
    assert.deepEqual(
        formattedChainItems.map((item) => item.label),
        ["limit", "skip", "sort"],
    );
    assert.deepEqual(
        formattedPrefixedItems.map((item) => item.label),
        ["limit"],
    );
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
    assert.equal(items.some((item) => item.label === "name"), false);
});

test("suggests query and update operators", () => {
    assert.ok(labels("db.users.find({ age: { $g").includes("$gte"));
    assert.ok(labels("db.users.updateOne({}, { $s").includes("$set"));
});

test("suggests aggregation stages inside aggregate pipeline", () => {
    const items = buildMongoCompletionItems("db.users.aggregate([{ $m", "db.users.aggregate([{ $m".length);

    assert.ok(items.find((item) => item.label === "$match" && item.detail === "aggregation stage"));
});

test("completion context is tolerant of unfinished input", () => {
    const context = getMongoCompletionContext('db.getCollection("users").find({ "', 'db.getCollection("users").find({ "'.length);

    assert.equal(context.mode, "field");
    assert.equal(context.collection, "users");
});

test("auto trigger opens for useful MongoDB characters only", () => {
    assert.equal(shouldAutoOpenMongoCompletion("db.", "db.".length), true);
    assert.equal(shouldAutoOpenMongoCompletion("db.users.find({ $", "db.users.find({ $".length), true);
    assert.equal(shouldAutoOpenMongoCompletion("db.users.find({", "db.users.find({".length), true);
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
