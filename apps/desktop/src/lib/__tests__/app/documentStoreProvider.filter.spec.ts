import { describe, expect, it } from "vitest";
import { buildDocumentFilterCondition, documentFieldPathTreeFromDocuments, documentFilterModeOptions, documentFilterModeOptionsFor, documentFilterValueTypeOptions } from "@/lib/app/documentStoreProvider";

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

  it("matches numeric MongoDB fields by their string representation", () => {
    expect(buildDocumentFilterCondition({ id: "contains", fieldName: "age", mode: "like", rawValue: "2", conjunction: "AND" }, { kind: "mongodb", sampleValue: 28 })).toEqual({
      $expr: {
        $regexMatch: {
          input: { $convert: { input: "$age", to: "string", onError: "", onNull: "" } },
          regex: "2",
          options: "i",
        },
      },
    });
    expect(buildDocumentFilterCondition({ id: "contains", fieldName: "age", mode: "like", rawValue: "2", valueType: "number", conjunction: "AND" }, { kind: "mongodb" })).toEqual({
      $expr: {
        $regexMatch: {
          input: { $convert: { input: "$age", to: "string", onError: "", onNull: "" } },
          regex: "2",
          options: "i",
        },
      },
    });
    expect(buildDocumentFilterCondition({ id: "not-contains", fieldName: "age", mode: "not-like", rawValue: "2", valueType: "number", conjunction: "AND" }, { kind: "mongodb" })).toEqual({
      $expr: {
        $not: [
          {
            $regexMatch: {
              input: { $convert: { input: "$age", to: "string", onError: "", onNull: "" } },
              regex: "2",
              options: "i",
            },
          },
        ],
      },
    });
  });

  it("keeps MongoDB string contains filters on the field regex path", () => {
    expect(buildDocumentFilterCondition({ id: "contains", fieldName: "name", mode: "like", rawValue: "张", conjunction: "AND" }, { kind: "mongodb", sampleValue: "张三" })).toEqual({
      name: { $regex: "张", $options: "i" },
    });
  });

  it("matches substrings that are not valid values of the column's own type", () => {
    // Regression for #10056: the typed parse ran before the operator was known, so searching a
    // JSON/number/date/boolean column for text threw and the Apply click did nothing.
    const samples: Array<[string, unknown]> = [
      ["json object", { a: 1, b: "abc" }],
      ["number", 42],
      ["int64", { $numberLong: "42" }],
      ["date", { $date: "2026-01-01T00:00:00Z" }],
      ["boolean", true],
    ];
    for (const [label, sampleValue] of samples) {
      for (const mode of ["like", "not-like", "begins-with", "ends-with"] as const) {
        const rule = { id: mode, fieldName: "MessageText", mode, rawValue: "abc", conjunction: "AND" as const };
        expect(() => buildDocumentFilterCondition(rule, { kind: "mongodb", sampleValue }), `${mode} on ${label}`).not.toThrow();
        expect(buildDocumentFilterCondition(rule, { kind: "mongodb", sampleValue }), `${mode} on ${label}`).not.toBeNull();
      }
    }

    // Non-string columns are matched through the $convert coercion form: plain $regex only
    // matches fields that hold a string, so it silently filtered such columns to 0 rows.
    expect(buildDocumentFilterCondition({ id: "contains", fieldName: "MessageText", mode: "like", rawValue: "abc", conjunction: "AND" }, { kind: "mongodb", sampleValue: { a: 1 } })).toEqual({
      $expr: {
        $regexMatch: {
          input: { $convert: { input: "$MessageText", to: "string", onError: "", onNull: "" } },
          regex: "abc",
          options: "i",
        },
      },
    });
    expect(buildDocumentFilterCondition({ id: "starts", fieldName: "MessageText", mode: "begins-with", rawValue: "abc", conjunction: "AND" }, { kind: "mongodb", sampleValue: { $date: "2026-01-01T00:00:00Z" } })).toEqual({
      $expr: {
        $regexMatch: {
          input: { $convert: { input: "$MessageText", to: "string", onError: "", onNull: "" } },
          regex: "^abc",
          options: "i",
        },
      },
    });
    expect(buildDocumentFilterCondition({ id: "not-contains", fieldName: "MessageText", mode: "not-like", rawValue: "abc", conjunction: "AND" }, { kind: "mongodb", sampleValue: true })).toEqual({
      $expr: {
        $not: [
          {
            $regexMatch: {
              input: { $convert: { input: "$MessageText", to: "string", onError: "", onNull: "" } },
              regex: "abc",
              options: "i",
            },
          },
        ],
      },
    });
    // Solr keeps the plain $regex path even for non-string samples: its driver translates
    // anchored $regex into fq clauses but cannot translate $expr.
    expect(buildDocumentFilterCondition({ id: "starts", fieldName: "MessageText", mode: "begins-with", rawValue: "abc", conjunction: "AND" }, { kind: "solr", sampleValue: 42 })).toEqual({
      MessageText: { $regex: "^abc", $options: "i" },
    });

    // Operators that genuinely need a typed value still reject text that is not one.
    expect(() => buildDocumentFilterCondition({ id: "eq", fieldName: "age", mode: "equals", rawValue: "abc", conjunction: "AND" }, { kind: "mongodb", sampleValue: 28 })).toThrow(/number/);
    expect(() => buildDocumentFilterCondition({ id: "gt", fieldName: "age", mode: "greater-than", rawValue: "abc", conjunction: "AND" }, { kind: "mongodb", sampleValue: 28 })).toThrow(/number/);
  });

  it("keeps the MongoDB _id sample for automatic type inference", () => {
    const tree = documentFieldPathTreeFromDocuments([{ _id: "001", name: "Alice" }]);

    expect(tree[0]).toMatchObject({ path: "_id", sampleValue: "001" });
  });

  it("offers the PostgreSQL-style operators for MongoDB only", () => {
    const mongoModes = documentFilterModeOptionsFor("mongodb").map((option) => option.value);
    expect(mongoModes).toEqual(expect.arrayContaining(["begins-with", "ends-with", "in", "not-in", "between", "not-between"]));
    for (const kind of ["elasticsearch", "dynamodb", "meilisearch"] as const) {
      const modes = documentFilterModeOptionsFor(kind).map((option) => option.value);
      for (const mode of ["begins-with", "ends-with", "in", "not-in", "between", "not-between"] as const) {
        expect(modes).not.toContain(mode);
      }
    }
    expect(buildDocumentFilterCondition({ id: "starts", fieldName: "name", mode: "begins-with", rawValue: "张", conjunction: "AND" }, { kind: "elasticsearch", sampleValue: "张三" })).toBeNull();
  });

  it("builds anchored prefix and suffix filters", () => {
    expect(buildDocumentFilterCondition({ id: "starts", fieldName: "name", mode: "begins-with", rawValue: "张", conjunction: "AND" }, { kind: "mongodb", sampleValue: "张三" })).toEqual({
      name: { $regex: "^张", $options: "i" },
    });
    expect(buildDocumentFilterCondition({ id: "ends", fieldName: "name", mode: "ends-with", rawValue: "三", conjunction: "AND" }, { kind: "mongodb", sampleValue: "张三" })).toEqual({
      name: { $regex: "三$", $options: "i" },
    });
    expect(buildDocumentFilterCondition({ id: "starts", fieldName: "name", mode: "begins-with", rawValue: "a.b", conjunction: "AND" }, { kind: "mongodb", sampleValue: "alice" })).toEqual({
      name: { $regex: "^a\\.b", $options: "i" },
    });
  });

  it("matches numeric MongoDB fields for prefix and suffix filters", () => {
    expect(buildDocumentFilterCondition({ id: "starts", fieldName: "age", mode: "begins-with", rawValue: "2", conjunction: "AND" }, { kind: "mongodb", sampleValue: 28 })).toEqual({
      $expr: {
        $regexMatch: {
          input: { $convert: { input: "$age", to: "string", onError: "", onNull: "" } },
          regex: "^2",
          options: "i",
        },
      },
    });
  });

  it("builds in and not-in filters from comma or newline separated values", () => {
    expect(buildDocumentFilterCondition({ id: "in", fieldName: "name", mode: "in", rawValue: "张三, 李四\n王五", conjunction: "AND" }, { kind: "mongodb", sampleValue: "张三" })).toEqual({
      name: { $in: ["张三", "李四", "王五"] },
    });
    expect(buildDocumentFilterCondition({ id: "not-in", fieldName: "age", mode: "not-in", rawValue: "18, 30", valueType: "number", conjunction: "AND" }, { kind: "mongodb" })).toEqual({
      age: { $nin: [18, 30] },
    });
    expect(buildDocumentFilterCondition({ id: "in", fieldName: "name", mode: "in", rawValue: "'a,b'", conjunction: "AND" }, { kind: "mongodb", sampleValue: "a" })).toEqual({
      name: { $in: ["a,b"] },
    });
    expect(buildDocumentFilterCondition({ id: "in", fieldName: "name", mode: "in", rawValue: "  , \n ", conjunction: "AND" }, { kind: "mongodb" })).toBeNull();
  });

  it("builds between and not-between filters", () => {
    expect(buildDocumentFilterCondition({ id: "between", fieldName: "age", mode: "between", rawValue: "18", rawEndValue: "30", valueType: "number", conjunction: "AND" }, { kind: "mongodb" })).toEqual({
      age: { $gte: 18, $lte: 30 },
    });
    expect(buildDocumentFilterCondition({ id: "not-between", fieldName: "age", mode: "not-between", rawValue: "18", rawEndValue: "30", valueType: "number", conjunction: "AND" }, { kind: "mongodb" })).toEqual({
      $or: [{ age: { $lt: 18 } }, { age: { $gt: 30 } }],
    });
    expect(buildDocumentFilterCondition({ id: "between", fieldName: "age", mode: "between", rawValue: "18", rawEndValue: "", conjunction: "AND" }, { kind: "mongodb" })).toBeNull();
    expect(buildDocumentFilterCondition({ id: "between", fieldName: "age", mode: "between", rawValue: "18", rawEndValue: "30", conjunction: "AND" }, { kind: "mysql" as never })).toBeNull();
  });
});
