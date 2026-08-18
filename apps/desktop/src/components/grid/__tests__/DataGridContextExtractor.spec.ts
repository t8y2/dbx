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

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(filterSource).toContain("const target = contextCell.value;");
    expect(filterSource).toContain("const sourceResult = props.result;");
    expect(filterSource).toContain("const sourceIndex = sourceItem.sourceIndex;");
    expect(filterSource).toContain("await hydrateLargeValueCell(target.rowId, target.col)");
    expect(filterSource).toContain("sourceResult.rows[sourceIndex]?.[target.col]");
    expect(filterSource).not.toContain("getRowItem(target.rowId);\n  if (!item)");
    expect(filterSource).not.toContain("contextColumn.value");
    expect(filterSource).not.toContain("contextCellValue.value");
  });
});
