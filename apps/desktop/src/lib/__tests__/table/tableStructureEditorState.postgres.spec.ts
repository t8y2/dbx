import { describe, expect, it } from "vitest";
import { combineDataTypeForDatabaseWithLengthUnit, createColumnDrafts, dataTypeBaseInputValue, dataTypeLengthInputValue, dataTypeLengthUnitValue, hasExistingColumnTypeChange } from "@/lib/table/tableStructureEditorState";

function editPrecision(dataType: string, precision: string): string {
  return combineDataTypeForDatabaseWithLengthUnit("postgres", dataTypeBaseInputValue("postgres", dataType), precision, dataTypeLengthUnitValue("postgres", dataType));
}

describe("PostgreSQL temporal precision editing (#10518)", () => {
  it.each([
    ["timestamp", "with time zone"],
    ["timestamp", "without time zone"],
    ["time", "with time zone"],
    ["time", "without time zone"],
    ["TIMESTAMP", "WITH TIME ZONE"],
  ])("preserves the qualifier for %s %s through precision edits", (type, qualifier) => {
    const original = `${type}(6) ${qualifier}`;
    const baseType = `${type} ${qualifier}`;
    expect(dataTypeBaseInputValue("postgres", original)).toBe(baseType);
    expect(dataTypeLengthInputValue("postgres", original)).toBe("6");
    for (const precision of ["0", "3", "6"]) {
      const edited = editPrecision(original, precision);
      expect(edited).toBe(`${type}(${precision}) ${qualifier}`);
      expect(dataTypeBaseInputValue("postgres", edited)).toBe(baseType);
      expect(dataTypeLengthInputValue("postgres", edited)).toBe(precision);
    }
    expect(editPrecision(original, "")).toBe(baseType);
    expect(editPrecision(baseType, "3")).toBe(`${type}(3) ${qualifier}`);
    for (const invalid of ["7", "-1", "3,2"]) {
      expect(editPrecision(original, invalid)).toBe(baseType);
    }
  });

  it.each(["timestamptz", "timetz", "timestamp", "time"])("keeps the existing %s short syntax", (type) => {
    expect(editPrecision(`${type}(6)`, "3")).toBe(`${type}(3)`);
    expect(editPrecision(`${type}(6)`, "")).toBe(type);
  });

  it("does not mark a loaded or comment-only edited column as a type change", () => {
    const original = "timestamp(6) with time zone";
    const drafts = createColumnDrafts([{ name: "ts_tz", data_type: original, is_nullable: true, column_default: null, is_primary_key: false }], "postgres");
    const draft = drafts[0]!;
    expect(draft.dataType).toBe(original);
    expect(dataTypeBaseInputValue("postgres", draft.dataType)).toBe("timestamp with time zone");
    expect(hasExistingColumnTypeChange(drafts)).toBe(false);
    draft.comment = "Updated description";
    expect(hasExistingColumnTypeChange(drafts)).toBe(false);
    draft.dataType = editPrecision(draft.dataType, "6");
    expect(hasExistingColumnTypeChange(drafts)).toBe(false);
    draft.dataType = editPrecision(draft.dataType, "3");
    expect(hasExistingColumnTypeChange(drafts)).toBe(true);
    expect(draft.original?.data_type).toBe(original);
    expect(draft.dataType).toBe("timestamp(3) with time zone");
  });

  it("accepts whitespace around precision and between qualifier words", () => {
    expect(editPrecision(" timestamp ( 6 ) WITH   TIME   ZONE ", "3")).toBe("timestamp(3) WITH TIME ZONE");
  });
});
