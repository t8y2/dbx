import { describe, expect, it } from "vitest";
import { buildMongoCompletionItemsFromContext, getMongoDocumentQueryCompletionContext, plainMongoCompletionInsertion, shouldAutoOpenMongoDocumentQueryCompletion, type MongoCompletionField } from "@/lib/mongo/mongoCompletion";

const FIELDS: MongoCompletionField[] = [
  { name: "_id", type: "objectId" },
  { name: "customerShippingAddress", type: "string" },
  { name: "customer.name", type: "string" },
  { name: "createdAt", type: "date" },
  { name: "中文字段", type: "string" },
  { name: "客户 名", type: "string" },
];

function contextAt(text: string, kind: "filter" | "sortKeys" = "filter", cursor = text.length) {
  return getMongoDocumentQueryCompletionContext(text, cursor, kind);
}

function labelsAt(text: string, kind: "filter" | "sortKeys" = "filter", cursor = text.length) {
  return buildMongoCompletionItemsFromContext(contextAt(text, kind, cursor), { fields: FIELDS }).map((item) => item.label);
}

describe("getMongoDocumentQueryCompletionContext", () => {
  it("completes fields at the root of a filter document", () => {
    expect(contextAt("{ ")).toMatchObject({ mode: "filterField", prefix: "", from: 2 });
    expect(labelsAt("{ ")).toEqual(expect.arrayContaining(["_id", "customerShippingAddress", "createdAt"]));
  });

  it("narrows fields by the typed prefix and reports where to splice it", () => {
    expect(contextAt("{ customerS")).toMatchObject({ mode: "filterField", prefix: "customerS", from: 2 });
    expect(labelsAt("{ customerS")).toEqual(["customerShippingAddress"]);
  });

  it("keeps Unicode and quoted spaces in the field prefix and splice range", () => {
    expect(contextAt("{ 中")).toMatchObject({ mode: "filterField", prefix: "中", from: 2 });
    expect(labelsAt("{ 中")).toEqual(["中文字段"]);
    expect(contextAt('{ "客户 名')).toMatchObject({ mode: "filterField", prefix: '"客户 名', from: 2 });
    expect(labelsAt('{ "客户 名')).toEqual(["客户 名"]);
  });

  it("matches fields case-insensitively inside a quoted key", () => {
    expect(contextAt('{ "created')).toMatchObject({ mode: "filterField", prefix: '"created', from: 2 });
    const items = buildMongoCompletionItemsFromContext(contextAt('{ "created'), { fields: FIELDS });
    expect(items.map((item) => item.apply)).toContain('"createdAt": ');
  });

  it("consumes an existing closing quote so a key is not double-quoted", () => {
    expect(contextAt('{ "created"', "filter", 10)).toMatchObject({ prefix: '"created', replaceClosingQuote: '"' });
  });

  it("offers whole-filter operators once $ is typed", () => {
    expect(labelsAt("{ $")).toEqual(expect.arrayContaining(["$and", "$or"]));
  });

  it("offers query operators inside a field constraint", () => {
    expect(contextAt("{ createdAt: { $g")).toMatchObject({ mode: "queryOperator", prefix: "$g" });
    expect(labelsAt("{ createdAt: { $g")).toEqual(expect.arrayContaining(["$gt", "$gte"]));
  });

  it("offers fields again inside an $and branch and after a comma", () => {
    expect(contextAt("{ $and: [{ ")).toMatchObject({ mode: "filterField" });
    expect(contextAt("{ _id: 1, ")).toMatchObject({ mode: "filterField" });
  });

  it("offers value constructors in value position", () => {
    expect(contextAt("{ _id: ")).toMatchObject({ mode: "value" });
    expect(labelsAt("{ _id: ")).toEqual(expect.arrayContaining(["ObjectId"]));
  });

  it("says nothing inside a string value", () => {
    expect(contextAt('{ customerShippingAddress: "Beij')).toMatchObject({ mode: "none" });
  });

  it("says nothing outside the document", () => {
    expect(contextAt("")).toMatchObject({ mode: "none" });
    expect(contextAt("{ _id: 1 }")).toMatchObject({ mode: "none" });
    expect(contextAt("{ _id: 1 } ")).toMatchObject({ mode: "none" });
    expect(contextAt("}")).toMatchObject({ mode: "none" });
  });

  it("never offers shell snippets a filter bar cannot hold", () => {
    // `db.` is a plain token here, not the start of a collection chain.
    expect(labelsAt("{ db.")).not.toEqual(expect.arrayContaining(["db.getCollection", "find"]));
  });

  it("completes sort keys without value or operator noise", () => {
    expect(contextAt("{ created", "sortKeys")).toMatchObject({ mode: "field", prefix: "created" });
    expect(labelsAt("{ created", "sortKeys")).toEqual(["createdAt"]);
    expect(contextAt("{ createdAt: ", "sortKeys")).toMatchObject({ mode: "none" });
    expect(contextAt("{ createdAt: -1, ", "sortKeys")).toMatchObject({ mode: "field" });
  });
});

describe("plainMongoCompletionInsertion", () => {
  it("leaves a plain key completion untouched, caret at the end", () => {
    expect(plainMongoCompletionInsertion("createdAt: ")).toEqual({ text: "createdAt: ", selectionStart: 11, selectionEnd: 11 });
  });

  it("drops an empty snippet marker and leaves the caret in its place", () => {
    expect(plainMongoCompletionInsertion("$gt: ${}")).toEqual({ text: "$gt: ", selectionStart: 5, selectionEnd: 5 });
    expect(plainMongoCompletionInsertion("$in: [${}]")).toEqual({ text: "$in: []", selectionStart: 6, selectionEnd: 6 });
  });

  it("selects a named placeholder so its default can be typed over", () => {
    expect(plainMongoCompletionInsertion('$regex: "${pattern}"')).toEqual({ text: '$regex: "pattern"', selectionStart: 9, selectionEnd: 16 });
  });

  it("drops the key separator when the text it lands in already has one", () => {
    expect(plainMongoCompletionInsertion('"createdAt": ', ": 1 }")).toEqual({ text: '"createdAt"', selectionStart: 11, selectionEnd: 11 });
    expect(plainMongoCompletionInsertion("createdAt: ", "  : 1 }")).toEqual({ text: "createdAt", selectionStart: 9, selectionEnd: 9 });
    // Nothing to fold into: the separator is still the completion's job.
    expect(plainMongoCompletionInsertion("createdAt: ", " }").text).toBe("createdAt: ");
    expect(plainMongoCompletionInsertion("createdAt: ", "").text).toBe("createdAt: ");
    // An operator snippet ends at its value, so its own colon must survive.
    expect(plainMongoCompletionInsertion("$gt: ${}", ": 1 }").text).toBe("$gt: ");
  });

  it("expands every marker but only selects the first", () => {
    expect(plainMongoCompletionInsertion("$mod: [${divisor}, ${remainder}]")).toEqual({ text: "$mod: [divisor, remainder]", selectionStart: 7, selectionEnd: 14 });
    expect(plainMongoCompletionInsertion('$split: [${}, "${,}"]')).toEqual({ text: '$split: [, ","]', selectionStart: 9, selectionEnd: 9 });
  });

  it("renders every operator table entry without leaving a marker behind", () => {
    const applies = buildMongoCompletionItemsFromContext(contextAt("{ createdAt: { "), { fields: FIELDS })
      .concat(buildMongoCompletionItemsFromContext(contextAt("{ $"), { fields: FIELDS }))
      .concat(buildMongoCompletionItemsFromContext(contextAt("{ createdAt: "), { fields: FIELDS }))
      .map((item) => item.apply ?? item.label);
    expect(applies.length).toBeGreaterThan(20);
    for (const apply of applies) {
      const insertion = plainMongoCompletionInsertion(apply);
      expect(insertion.text, apply).not.toContain("${");
      expect(insertion.selectionEnd, apply).toBeLessThanOrEqual(insertion.text.length);
    }
  });
});

describe("shouldAutoOpenMongoDocumentQueryCompletion", () => {
  it("opens on the characters that start a key, an operator, or a value", () => {
    for (const text of ["{", "{ ", "{ cre", '{ "cre', "{ 中", '{ "客户 名', "{ $", "{ _id: 1,", "{ createdAt: {", "{ createdAt: "]) {
      expect(shouldAutoOpenMongoDocumentQueryCompletion(text, text.length, "filter"), text).toBe(true);
    }
  });

  it("stays closed where there is nothing to say", () => {
    for (const text of ["", "{ _id: 1 }", "{ _id: 1 } ", '{ name: "x']) {
      expect(shouldAutoOpenMongoDocumentQueryCompletion(text, text.length, "filter"), text).toBe(false);
    }
  });
});
