import { describe, expect, it } from "vitest";
import { buildDocumentFilterCondition, documentFilterModeOptions } from "@/lib/app/documentStoreProvider";

describe("document store structured filters", () => {
  it("offers and builds inclusive comparison filters", () => {
    expect(documentFilterModeOptions.map((option) => option.value)).toEqual(expect.arrayContaining(["greater-than-or-equal", "less-than-or-equal"]));
    expect(buildDocumentFilterCondition({ id: "gte", fieldName: "score", mode: "greater-than-or-equal", rawValue: "80", conjunction: "AND" })).toEqual({ score: { $gte: 80 } });
    expect(buildDocumentFilterCondition({ id: "lte", fieldName: "score", mode: "less-than-or-equal", rawValue: "80", conjunction: "AND" })).toEqual({ score: { $lte: 80 } });
  });
});
