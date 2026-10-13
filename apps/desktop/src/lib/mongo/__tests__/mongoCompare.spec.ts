import { describe, expect, it } from "vitest";
import { compareMongoDocuments, mongoCompareCsv, mongoCompareFingerprint, mongoSnapshotFilter, planMongoSync } from "../mongoCompare";

describe("Mongo comparison", () => {
  it("classifies differences, missing fields, empty objects, ordered arrays and unmatched documents", () => {
    const result = compareMongoDocuments([{ _id: 1, profile: { city: "London", missing: null }, list: [1, 2] }, { _id: 2, a: 1, b: 2 }, { _id: 3 }, { _id: 5, empty: {} }], [{ _id: 1, profile: { city: "Paris" }, list: [2, 1] }, { b: 2, a: 1, _id: 2 }, { _id: 4 }, { _id: 5 }], {
      matchFields: ["_id"],
    });
    expect(result.counts).toEqual({ different: 2, same: 1, sourceOnly: 1, targetOnly: 1, multiple: 0 });
    expect(result.rows[0].fields.map((field) => field.path)).toEqual(["profile.city", "profile.missing", "list"]);
    expect(result.rows[0].fields[1]).toMatchObject({ sourceExists: true, targetExists: false });
  });

  it("retains BSON scalar types, including unsafe Int64 and strings resembling ObjectIds", () => {
    const id = "507f1f77bcf86cd799439011";
    const result = compareMongoDocuments([{ _id: 1, oid: { $oid: id }, n: { $numberLong: "9007199254740993" }, d: { $date: { $numberLong: "1" } } }], [{ _id: 1, oid: id, n: { $numberLong: "9007199254740992" }, d: { $date: { $numberLong: "2" } } }], { matchFields: ["_id"] });
    expect(result.rows[0].fields.map((field) => field.path)).toEqual(["oid", "n", "d"]);
    expect(mongoCompareFingerprint({ $numberLong: "9007199254740993" }, true)).not.toBe(mongoCompareFingerprint({ $numberLong: "9007199254740992" }, true));
  });

  it("optionally compares numeric types with exact decimal normalization", () => {
    for (const [left, right] of [
      [{ $numberInt: "42" }, { $numberLong: "42" }],
      [{ $numberDecimal: "1.2500" }, { $numberDouble: "1.25" }],
      [{ $numberDecimal: "100e-2" }, { $numberInt: "1" }],
      [{ $numberDecimal: "-0.0" }, { $numberDouble: "0.0" }],
    ]) {
      expect(mongoCompareFingerprint(left, true)).toBe(mongoCompareFingerprint(right, true));
      expect(mongoCompareFingerprint(left)).not.toBe(mongoCompareFingerprint(right));
    }
  });

  it("supports compound nested keys and reports duplicate or missing keys without pairing", () => {
    const result = compareMongoDocuments([{ _id: 1, key: { id: "x" }, region: "EU" }, { _id: 2, key: { id: "x" }, region: "EU" }, { _id: 3 }], [{ _id: 4, key: { id: "x" }, region: "EU" }], { matchFields: ["key.id", "region"] });
    expect(result.counts.multiple).toBe(2);
    expect(result.rows[0]).toMatchObject({ sourceMatches: 2, targetMatches: 1 });
    expect(planMongoSync(result.rows[0], "target")).toBeNull();
    expect(compareMongoDocuments([{ _id: "<missing>" }], [{ _id: "<missing>" }], { matchFields: ["_id"] }).counts.same).toBe(1);
  });

  it("preserves ignored descendants and the destination _id during bidirectional updates", () => {
    const row = compareMongoDocuments([{ _id: 1, key: "A", profile: { city: "Paris", timestamp: 10 }, a: null }], [{ _id: 2, key: "A", profile: { city: "London", timestamp: 20 }, b: 2 }], { matchFields: ["key"], ignoredFields: ["profile.timestamp"] }).rows[0];
    expect(planMongoSync(row, "target")?.after).toEqual({ _id: 2, key: "A", profile: { city: "Paris", timestamp: 20 }, a: null });
    expect(planMongoSync(row, "source")?.after).toEqual({ _id: 1, key: "A", profile: { city: "London", timestamp: 10 }, b: 2 });
    expect(planMongoSync(row, "target", [["profile", "city"]])?.after).toEqual({ _id: 2, key: "A", profile: { city: "Paris", timestamp: 20 }, b: 2 });
    expect(planMongoSync(row, "target", [["_id"]])).toBeNull();
  });

  it("ignores excluded descendants when their containing object is missing on one side", () => {
    const row = compareMongoDocuments([{ _id: 1, meta: { keep: true, ignore: 1 } }], [{ _id: 1 }], { matchFields: ["_id"], ignoredFields: ["meta.ignore"] }).rows[0];
    expect(planMongoSync(row, "target")?.after).toEqual({ _id: 1, meta: { keep: true } });
  });

  it("plans additions and deletions according to the selected direction", () => {
    const row = compareMongoDocuments([{ _id: 1, value: 'ISODate("2020-01-01")' }], [], { matchFields: ["_id"] }).rows[0];
    expect(planMongoSync(row, "target")).toMatchObject({ kind: "insert", after: row.source });
    expect(planMongoSync(row, "source")).toMatchObject({ kind: "delete", before: row.source });
  });

  it("keeps special BSON document field names as data rather than mutating prototypes", () => {
    const left = JSON.parse('{"_id":1,"__proto__":{"evil":true},"a.b":4}');
    const right = JSON.parse('{"_id":1,"__proto__":{"evil":false},"a.b":3}');
    const row = compareMongoDocuments([left], [right], { matchFields: ["_id"] }).rows[0];
    expect(planMongoSync(row, "target")?.after).toEqual(left);
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
  });

  it("copies exactly one field when a literal dotted name and a nested path coexist", () => {
    const row = compareMongoDocuments([{ _id: 1, "a.b": 2, a: { b: 3 } }], [{ _id: 1, "a.b": 0, a: { b: 0 } }], { matchFields: ["_id"] }).rows[0];
    expect(planMongoSync(row, "target", [["a.b"]])?.after).toEqual({ _id: 1, "a.b": 2, a: { b: 0 } });
  });

  it("builds literal snapshot predicates and escapes CSV quotes and newlines", () => {
    const document = { _id: "507f1f77bcf86cd799439011", text: '"hello"\nworld', operator: { $ne: null } };
    expect(mongoSnapshotFilter(document)).toEqual({ _id: { $eq: document._id }, $expr: { $eq: ["$$ROOT", { $literal: document }] } });
    const csv = mongoCompareCsv(compareMongoDocuments([document], [], { matchFields: ["_id"] }));
    expect(csv.startsWith("status,key,field,source,target\r\n")).toBe(true);
    expect(csv).toContain('""text""');
    expect(csv).toContain("\\nworld");
  });
});
