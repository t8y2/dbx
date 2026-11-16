import { describe, expect, it } from "vitest";
import { resolveDataGridCellTextRole } from "@/lib/dataGrid/dataGridCellTextVisual";
import { resolveDataGridTypeVisualKind, resolveHeaderColumnType, type DataGridTypeVisualKind } from "@/lib/dataGrid/dataGridColumnType";

describe("data grid type visual kind", () => {
  it.each<[string, DataGridTypeVisualKind]>([
    ["BIGINT", "integer"],
    ["Nullable(UInt64)", "integer"],
    ["DECIMAL(18, 4)", "numeric"],
    ["DOUBLE PRECISION", "numeric"],
    ["character varying(255)", "string"],
    ["BOOLEAN", "boolean"],
    ["timestamp with time zone", "temporal"],
    ["JSONB", "structured"],
    ["Array(Nullable(UInt64))", "structured"],
    ["text[]", "structured"],
    ["_int4", "structured"],
    ["_text", "structured"],
    ["_jsonb", "structured"],
    ["_uuid", "structured"],
    ["UUID", "identifier"],
    ["BYTEA", "binary"],
    ["SDO_GEOMETRY", "spatial"],
    ["keyword", "string"],
    ["unsigned_long", "integer"],
    ["scaled_float", "numeric"],
    ["date_nanos", "temporal"],
    ["nested", "structured"],
    ["inet", "unknown"],
  ])("maps %s to %s", (dataType, expected) => {
    expect(resolveDataGridTypeVisualKind(dataType)).toBe(expected);
  });

  it("keeps an absent type neutral", () => {
    expect(resolveDataGridTypeVisualKind(undefined)).toBe("unknown");
    expect(resolveDataGridTypeVisualKind("  ")).toBe("unknown");
  });

  it.each([
    ["timestamp", "sqlserver", "binary"],
    ["rowversion", "sqlserver", "binary"],
    ["bit(8)", "postgres", "binary"],
    ["bit varying(8)", "postgres", "binary"],
    ["long", "elasticsearch", "integer"],
    ["long", "easysearch", "integer"],
    ["byte", "elasticsearch", "integer"],
    ["short", "elasticsearch", "integer"],
  ] as const)("maps %s for %s to %s", (dataType, databaseType, expected) => {
    expect(resolveDataGridTypeVisualKind(dataType, databaseType)).toBe(expected);
  });

  it("keeps ambiguous types on their generic defaults without a matching dialect", () => {
    expect(resolveDataGridTypeVisualKind("timestamp")).toBe("temporal");
    expect(resolveDataGridTypeVisualKind("timestamp", "postgres")).toBe("temporal");
    expect(resolveDataGridTypeVisualKind("bit")).toBe("boolean");
    expect(resolveDataGridTypeVisualKind("bit", "sqlserver")).toBe("boolean");
    expect(resolveDataGridTypeVisualKind("long")).toBe("string");
    expect(resolveDataGridTypeVisualKind("long", "oracle")).toBe("string");
    expect(resolveDataGridTypeVisualKind("byte")).toBe("unknown");
    expect(resolveDataGridTypeVisualKind("short")).toBe("unknown");
  });
});

describe("data grid header type color", () => {
  it("uses the displayed metadata type for the standard header color", () => {
    const displayedType = resolveHeaderColumnType({
      tableColumnType: "decimal(10,2)",
      resultColumnTypes: ["text"],
      actualColIdx: 0,
    });

    expect(displayedType).toBe("decimal(10,2)");
    expect(resolveDataGridTypeVisualKind(displayedType)).toBe("numeric");
  });
});

describe("data grid cell text visual priority", () => {
  const ordinaryInteger = {
    colorizeTypes: true,
    typeKind: "integer" as const,
  };

  it("uses a type color only for an ordinary typed value", () => {
    expect(resolveDataGridCellTextRole(ordinaryInteger)).toBe("type");
  });

  it.each([{ colorizeTypes: false }, { typeKind: "unknown" as const }, { isEditing: true }, { isControl: true }, { isSelected: true }, { isCurrentSearchMatch: true }, { isSearchMatch: true }, { isDirty: true }, { isDeleted: true }])("keeps interaction state visually dominant for %o", (override) => {
    expect(resolveDataGridCellTextRole({ ...ordinaryInteger, ...override })).toBe("neutral");
  });

  it.each([{ isNull: true }, { isDraft: true }, { isNull: true, isSelected: true }])("keeps null and draft placeholders muted for %o", (override) => {
    expect(resolveDataGridCellTextRole({ ...ordinaryInteger, ...override })).toBe("muted");
  });

  it("keeps NULL muted when type colors are disabled", () => {
    expect(resolveDataGridCellTextRole({ ...ordinaryInteger, colorizeTypes: false, isNull: true })).toBe("muted");
  });
});
