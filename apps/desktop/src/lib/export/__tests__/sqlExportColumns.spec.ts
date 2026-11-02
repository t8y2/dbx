import { describe, expect, it } from "vitest";
import { resolveSqlExportColumnIndexes, sqlExportColumnChoices } from "@/lib/export/sqlExportColumns";

describe("SQL export column identities", () => {
  it("retains source positions and distinguishes duplicate labels", () => {
    expect(sqlExportColumnChoices(["id", undefined, "name", "id"])).toEqual([
      { sourceIndex: 0, name: "id", nameOccurrence: 0 },
      { sourceIndex: 2, name: "name", nameOccurrence: 0 },
      { sourceIndex: 3, name: "id", nameOccurrence: 1 },
    ]);
  });

  it("resolves duplicate occurrences after columns are reordered or internal keys removed", () => {
    const choices = sqlExportColumnChoices(["__DBX_ROWID", "id", "name", "id"]);
    expect(resolveSqlExportColumnIndexes(["id", "id", "name"], [choices[3]!, choices[2]!])).toEqual([1, 2]);
  });

  it("preserves omitted selection and rejects empty, missing and repeated selections", () => {
    const choices = sqlExportColumnChoices(["id", "id"]);
    expect(resolveSqlExportColumnIndexes(["id", "name"])).toEqual([0, 1]);
    expect(() => resolveSqlExportColumnIndexes(["id"], [])).toThrow("at least one");
    expect(() => resolveSqlExportColumnIndexes(["id"], [choices[1]!])).toThrow("not found");
    expect(() => resolveSqlExportColumnIndexes(["id"], [choices[0]!, choices[0]!])).toThrow("more than once");
  });

  it("handles wide projections without collapsing equal labels", () => {
    const columns = Array.from({ length: 10000 }, () => "value");
    const choices = sqlExportColumnChoices(columns);
    expect(resolveSqlExportColumnIndexes(columns, choices)).toEqual(columns.map((_, index) => index));
  });
});
