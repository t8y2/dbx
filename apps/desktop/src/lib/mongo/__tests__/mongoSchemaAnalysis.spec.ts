import { describe, expect, it } from "vitest";
import { analyzeMongoSchema } from "../mongoSchemaAnalysis";

describe("Mongo schema analysis", () => {
  it("counts presence per document, occurrences across arrays, and BSON scalar types", () => {
    const result = analyzeMongoSchema([{ _id: { $oid: "507f1f77bcf86cd799439011" }, name: "one", address: { city: "Paris" }, items: [{ sku: "a" }, { sku: "b" }] }, { _id: { $oid: "507f1f77bcf86cd799439012" }, name: 2, address: null, items: [] }, { _id: { $oid: "507f1f77bcf86cd799439013" } }], true);
    expect(result.documentCount).toBe(3);
    expect(result.fields.find((field) => field.path === '$["name"]')).toMatchObject({ documents: 2, missing: 1, types: { string: 1, number: 1 } });
    expect(result.fields.find((field) => field.path === '$["items"][]["sku"]')).toMatchObject({ documents: 1, occurrences: 2, missing: 2 });
    expect(result.fields.find((field) => field.path === '$["_id"]')?.types).toEqual({ objectId: 3 });
  });

  it("bounds recursive depth and total distinct field paths", () => {
    let deep: Record<string, unknown> = { end: 1 };
    for (let i = 0; i < 40; i++) deep = { child: deep };
    const depth = analyzeMongoSchema([{ deep }]);
    expect(depth.depthLimited).toBe(true);
    const wide = Object.fromEntries(Array.from({ length: 10010 }, (_, index) => [`f${index}`, index]));
    const bounded = analyzeMongoSchema([wide]);
    expect(bounded.fields).toHaveLength(10000);
    expect(bounded.fieldLimited).toBe(true);
  });
});
