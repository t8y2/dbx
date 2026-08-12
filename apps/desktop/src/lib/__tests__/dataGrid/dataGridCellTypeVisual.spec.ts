import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveDataGridCellTextRole } from "@/lib/dataGrid/dataGridCellTextVisual";
import { resolveDataGridTypeVisualKind, resolveHeaderColumnType, type DataGridTypeVisualKind } from "@/lib/dataGrid/dataGridColumnType";

const dataGridSource = readFileSync(new URL("../../../components/grid/DataGrid.vue", import.meta.url), "utf8");
const globalStylesSource = readFileSync(new URL("../../../styles/globals.css", import.meta.url), "utf8");

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
  ] as const)("maps %s for %s to %s", (dataType, databaseType, expected) => {
    expect(resolveDataGridTypeVisualKind(dataType, databaseType)).toBe(expected);
  });

  it("keeps ambiguous types on their generic defaults without a matching dialect", () => {
    expect(resolveDataGridTypeVisualKind("timestamp")).toBe("temporal");
    expect(resolveDataGridTypeVisualKind("timestamp", "postgres")).toBe("temporal");
    expect(resolveDataGridTypeVisualKind("bit")).toBe("boolean");
    expect(resolveDataGridTypeVisualKind("bit", "sqlserver")).toBe("boolean");
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
    expect(dataGridSource).toContain(':type-class="typeColorClass(headerColumnType(col.name, col.actualColIdx))"');
    expect(dataGridSource).not.toContain("typeColorClass(allColumnTypes[col.actualColIdx]");
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

  it("uses a neutral foreground on editable DOM hover surfaces", () => {
    expect(dataGridSource).toContain("'hover:bg-gray-200 hover:text-foreground dark:hover:bg-gray-800':");
    expect(dataGridSource).toContain("'cursor-text hover:bg-gray-200 hover:text-foreground dark:hover:bg-gray-800':");
  });

  it("returns before reading cell state when type colors are disabled", () => {
    expect(dataGridSource).toContain('function gridCellTextColorClass(item: RowItem, actualColIdx: number, visibleColIdx: number): string {\n  if (!colorizeDataGridCellTypes.value) return "text-foreground";\n  const value = item.data[actualColIdx];');
    expect(dataGridSource).toContain('function transposeCellTextColorClass(recordIndex: number, actualColIdx: number): string {\n  if (!colorizeDataGridCellTypes.value) return "text-foreground";\n  const item = displayItems.value[recordIndex];');
  });

  it("places data-grid type selectors in the components layer", () => {
    const componentsLayerStart = globalStylesSource.indexOf("@layer components {");
    const integerTypeSelector = globalStylesSource.indexOf(".data-grid-type-integer");

    expect(componentsLayerStart).toBeGreaterThan(-1);
    expect(integerTypeSelector).toBeGreaterThan(componentsLayerStart);
  });
});
