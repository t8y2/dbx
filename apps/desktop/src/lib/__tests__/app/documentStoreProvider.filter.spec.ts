import { describe, expect, it } from "vitest";
import { buildDocumentFilterCondition, documentFieldPathTreeFromDocuments, documentFilterModeOptions, documentFilterValueTypeOptions } from "@/lib/app/documentStoreProvider";

describe("document store structured filters", () => {
  it("offers and builds inclusive comparison filters", () => {
    expect(documentFilterModeOptions.map((option) => option.value)).toEqual(expect.arrayContaining(["greater-than-or-equal", "less-than-or-equal"]));
    expect(buildDocumentFilterCondition({ id: "gte", fieldName: "score", mode: "greater-than-or-equal", rawValue: "80", conjunction: "AND" })).toEqual({ score: { $gte: 80 } });
    expect(buildDocumentFilterCondition({ id: "lte", fieldName: "score", mode: "less-than-or-equal", rawValue: "80", conjunction: "AND" })).toEqual({ score: { $lte: 80 } });
  });

  it("infers MongoDB primitive and BSON types from field samples", () => {
    const rule = { id: "id", fieldName: "_id", mode: "equals" as const, rawValue: "1", conjunction: "AND" as const };

    expect(buildDocumentFilterCondition(rule, { kind: "mongodb", sampleValue: "001" })).toEqual({ _id: "1" });
    expect(buildDocumentFilterCondition(rule, { kind: "mongodb", sampleValue: 1 })).toEqual({ _id: 1 });
    expect(buildDocumentFilterCondition({ ...rule, rawValue: "true" }, { kind: "mongodb", sampleValue: false })).toEqual({ _id: true });
    expect(buildDocumentFilterCondition({ ...rule, rawValue: "507f1f77bcf86cd799439011" }, { kind: "mongodb", sampleValue: { $oid: "507f191e810c19729de860ea" } })).toEqual({
      _id: { $oid: "507f1f77bcf86cd799439011" },
    });
  });

  it("lets MongoDB filters override the inferred value type", () => {
    const baseRule = { id: "id", fieldName: "_id", mode: "equals" as const, rawValue: "1", conjunction: "AND" as const };

    expect(documentFilterValueTypeOptions.map((option) => option.value)).toEqual(["auto", "string", "number", "boolean", "object-id", "date", "int32", "int64", "decimal128", "json"]);
    expect(buildDocumentFilterCondition({ ...baseRule, valueType: "string" }, { kind: "mongodb", sampleValue: 1 })).toEqual({ _id: "1" });
    expect(buildDocumentFilterCondition({ ...baseRule, valueType: "number" }, { kind: "mongodb", sampleValue: "1" })).toEqual({ _id: 1 });
    expect(buildDocumentFilterCondition({ ...baseRule, rawValue: "2147483647", valueType: "int32" }, { kind: "mongodb" })).toEqual({ _id: { $numberInt: "2147483647" } });
    expect(buildDocumentFilterCondition({ ...baseRule, rawValue: "9223372036854775807", valueType: "int64" }, { kind: "mongodb" })).toEqual({ _id: { $numberLong: "9223372036854775807" } });
    expect(buildDocumentFilterCondition({ ...baseRule, rawValue: "12.50", valueType: "decimal128" }, { kind: "mongodb" })).toEqual({ _id: { $numberDecimal: "12.50" } });
    expect(buildDocumentFilterCondition({ ...baseRule, rawValue: "2026-08-07T00:00:00.000Z", valueType: "date" }, { kind: "mongodb" })).toEqual({ _id: { $date: "2026-08-07T00:00:00.000Z" } });
    expect(buildDocumentFilterCondition({ ...baseRule, rawValue: '{"status":"ok"}', valueType: "json" }, { kind: "mongodb" })).toEqual({ _id: { status: "ok" } });
    expect(() => buildDocumentFilterCondition({ ...baseRule, rawValue: "not-a-number", valueType: "number" }, { kind: "mongodb" })).toThrow("Invalid MongoDB number filter value");
  });

  it("keeps the MongoDB _id sample for automatic type inference", () => {
    const tree = documentFieldPathTreeFromDocuments([{ _id: "001", name: "Alice" }]);

    expect(tree[0]).toMatchObject({ path: "_id", sampleValue: "001" });
  });
});
