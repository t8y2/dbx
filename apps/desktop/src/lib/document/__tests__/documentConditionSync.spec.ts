import { describe, expect, it } from "vitest";
import { buildDocumentFilterCondition } from "@/lib/app/documentStoreProvider";
import { buildMongoSortInput, parseMongoFilterRules, parseMongoSortInput } from "@/lib/document/documentConditionSync";

describe("Mongo condition editor synchronization", () => {
  it("imports and serializes sort order without dropping secondary fields", () => {
    const rules = parseMongoSortInput('{"name":-1,"nested.id":1}')!;
    expect(rules).toEqual([
      { columnName: "name", direction: "desc" },
      { columnName: "nested.id", direction: "asc" },
    ]);
    expect(buildMongoSortInput(rules.map((rule, index) => ({ ...rule, id: String(index) })))).toBe('{"name":-1,"nested.id":1}');
  });

  it.each(['{"score":{"$meta":"textScore"}}', '{"name":0}', '{"name":'])("leaves unsupported or incomplete sort %s editable", (value) => {
    expect(parseMongoSortInput(value)).toBeUndefined();
  });

  it.each([{ name: "6" }, { name: "" }, { name: "  " }, { id: { $gte: 2 } }, { id: { $ne: null } }, { owner: { $oid: "507f1f77bcf86cd799439011" } }, { flags: { nested: true } }, { id: { $in: [1, "2", null] } }])("keeps the filter value's BSON type when importing %j", (filter) => {
    const rules = parseMongoFilterRules(filter)!;
    expect(rules).toHaveLength(1);
    expect(buildDocumentFilterCondition({ ...rules[0]!, id: "rule" }, { kind: "mongodb" })).toEqual(filter);
  });

  it("does not flatten mixed grouping or unknown Mongo operators", () => {
    expect(parseMongoFilterRules({ $or: [{ name: "x" }, { $and: [{ id: 1 }, { id: 2 }] }] })).toBeUndefined();
    expect(parseMongoFilterRules({ $expr: { $eq: ["$id", 1] } })).toBeUndefined();
    expect(parseMongoFilterRules({ id: { $gt: null } })).toBeUndefined();
  });
});
