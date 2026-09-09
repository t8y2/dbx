import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid setup initialization order", () => {
  it("initializes table column metadata before column width measurement", () => {
    const tableColumnMetadataDeclaration = dataGridSource.indexOf("const tableColumnsByResultIndex = computed");
    const columnResizeInitialization = dataGridSource.indexOf("useDataGridColumnResize({");

    expect(tableColumnMetadataDeclaration).toBeGreaterThanOrEqual(0);
    expect(columnResizeInitialization).toBeGreaterThan(tableColumnMetadataDeclaration);
  });

  it("initializes column formatters before measuring formatted column widths", () => {
    const columnFormatterDeclaration = dataGridSource.indexOf("} = useDataGridColumnFormatter({");
    const columnWidthInitialization = dataGridSource.lastIndexOf("initColumnWidths();");

    expect(columnFormatterDeclaration).toBeGreaterThanOrEqual(0);
    expect(columnWidthInitialization).toBeGreaterThan(columnFormatterDeclaration);
    expect(dataGridSource).toContain("columnFormatterForWidth?.(columnIndex)");
  });

  it("initializes where-search capability before the immediate filter preview watcher", () => {
    const canUseWhereSearchDeclaration = dataGridSource.indexOf("const canUseWhereSearch = computed");
    const filterPreviewDeclaration = dataGridSource.indexOf("const filterPreviewVisible = computed");
    const filterPreviewWatcher = dataGridSource.indexOf("[filterPreviewVisible, structuredFilterRules]");

    expect(canUseWhereSearchDeclaration).toBeGreaterThanOrEqual(0);
    expect(filterPreviewDeclaration).toBeGreaterThan(canUseWhereSearchDeclaration);
    expect(filterPreviewWatcher).toBeGreaterThan(filterPreviewDeclaration);
  });

  it("does not expose an uninitialized large-value runtime to startup callbacks", () => {
    expect(dataGridSource).toContain("let largeValueRuntime: ReturnType<typeof useDataGridLargeValues> | undefined;");
    expect(dataGridSource).toContain("largeValueRuntime?.scheduleVisibleLargeValuePreviewHydration(delay)");
    expect(dataGridSource).toContain("largeValueRuntime?.hydrateLargeValueCell(rowId, columnIndex) ?? false");
  });
});
