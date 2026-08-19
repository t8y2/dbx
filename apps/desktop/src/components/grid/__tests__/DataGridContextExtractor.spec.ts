import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid context extractor lifecycle", () => {
  it("clears the right-click target after the context-menu action has started", () => {
    expect(source).toContain('@open="onGridContextMenuOpen"');
    expect(source).toContain('@close="onGridContextMenuClose"');
    expect(source).toContain("queueMicrotask(() => {");
    expect(source).toContain("invalidateSyntheticContextSelection();");
  });

  it("resolves menu items after the right-click target is updated", () => {
    expect(source).toContain(':items="currentGridContextMenuItems"');
    expect(source).toContain("return gridContextMenuItems.value;");
  });

  it("snapshots the filter target before asynchronous value hydration", () => {
    const start = source.indexOf("async function contextFilterCondition");
    const end = source.indexOf("async function applyContextFilter", start);
    const filterSource = source.slice(start, end);
    const openStart = source.indexOf("function onGridContextMenuOpen");
    const openEnd = source.indexOf("function onGridContextMenuClose", openStart);
    const openSource = source.slice(openStart, openEnd);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(openStart).toBeGreaterThanOrEqual(0);
    expect(openEnd).toBeGreaterThan(openStart);
    expect(openSource).toContain("contextFilterTarget.value =");
    expect(openSource).toContain("cell && columnName && sourceItem");
    expect(openSource).toContain("sourceResult: props.result,");
    expect(openSource).toContain("sourceValue: sourceItem.data[cell.col] ?? null,");
    expect(openSource).toContain("() => props.result,");
    expect(openSource).toContain("contextFilterTarget.value?.sourceResult !== result");
    expect(filterSource).toContain("const target = contextFilterTarget.value;");
    expect(filterSource).toContain("const { columnName, sourceResult, sourceIndex, sourceValue, requiresHydration } = target;");
    expect(filterSource).toContain("await hydrateLargeValueCell(target.rowId, target.col)");
    expect(filterSource).toContain("sourceResult.rows[sourceIndex]?.[target.col]");
    expect(filterSource).not.toContain("contextCell.value");
    expect(filterSource).not.toContain("getRowItem(target.rowId);\n  if (!item)");
    expect(filterSource).not.toContain("contextColumn.value");
    expect(filterSource).not.toContain("contextCellValue.value");
  });
});
