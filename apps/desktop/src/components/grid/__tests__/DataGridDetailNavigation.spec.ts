import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adjacentDataGridDetailIndex, detailNavigationDelta, shouldIgnoreDataGridDetailNavigation } from "../../../lib/dataGrid/dataGridDetailNavigation";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");
const detailDialogsSource = readFileSync(new URL("../DataGridDetailDialogs.vue", import.meta.url), "utf8");

function keyboardEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: "ArrowDown",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: null,
    currentTarget: {},
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
    ...overrides,
  } as unknown as KeyboardEvent;
}

function targetMatching(selectorPart: string): EventTarget {
  return { closest: (selector: string) => (selector.includes(selectorPart) ? {} : null) } as unknown as EventTarget;
}

function functionBody(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  return start >= 0 && end > start ? source.slice(start, end) : "";
}

describe("DataGrid detail navigation index", () => {
  it("follows the supplied displayed order instead of deriving neighboring ids", () => {
    const displayedRows = [42, 7, 99];
    const currentRowIndex = displayedRows.indexOf(7);
    const previousRowIndex = adjacentDataGridDetailIndex(currentRowIndex, -1, displayedRows.length);
    const nextRowIndex = adjacentDataGridDetailIndex(currentRowIndex, 1, displayedRows.length);

    expect(displayedRows[previousRowIndex!]).toBe(42);
    expect(displayedRows[nextRowIndex!]).toBe(99);
    expect(displayedRows[previousRowIndex!]).not.toBe(6);
    expect(displayedRows[nextRowIndex!]).not.toBe(8);

    const visibleColumns = [5, 1, 3];
    const currentColumnPosition = visibleColumns.indexOf(1);
    expect(visibleColumns[adjacentDataGridDetailIndex(currentColumnPosition, -1, visibleColumns.length)!]).toBe(5);
    expect(visibleColumns[adjacentDataGridDetailIndex(currentColumnPosition, 1, visibleColumns.length)!]).toBe(3);
  });

  it("returns no-op indexes at every row and column boundary", () => {
    expect(adjacentDataGridDetailIndex(0, -1, 3)).toBeNull();
    expect(adjacentDataGridDetailIndex(2, 1, 3)).toBeNull();
    expect(adjacentDataGridDetailIndex(0, -1, 1)).toBeNull();
    expect(adjacentDataGridDetailIndex(0, 1, 1)).toBeNull();
    expect(adjacentDataGridDetailIndex(-1, 1, 3)).toBeNull();

    const visibleColumns = [5, 1, 3];
    expect(adjacentDataGridDetailIndex(visibleColumns.indexOf(5), -1, visibleColumns.length)).toBeNull();
    expect(adjacentDataGridDetailIndex(visibleColumns.indexOf(3), 1, visibleColumns.length)).toBeNull();
  });

  it("maps only the matching arrows to each detail axis", () => {
    expect(detailNavigationDelta("ArrowUp", "row")).toBe(-1);
    expect(detailNavigationDelta("ArrowDown", "row")).toBe(1);
    expect(detailNavigationDelta("ArrowLeft", "column")).toBe(-1);
    expect(detailNavigationDelta("ArrowRight", "column")).toBe(1);
    expect(detailNavigationDelta("ArrowLeft", "row")).toBeNull();
    expect(detailNavigationDelta("ArrowDown", "column")).toBeNull();
  });
});

describe("DataGrid detail keyboard safety", () => {
  it("ignores all arrows from inputs, textareas, contenteditable, and textbox targets", () => {
    for (const selectorPart of ["input", "textarea", "contenteditable", "textbox"]) {
      const target = targetMatching(selectorPart);
      for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
        expect(shouldIgnoreDataGridDetailNavigation(keyboardEvent({ key, target }))).toBe(true);
      }
    }
  });

  it("leaves nested overlays, modified arrows, and already-handled events alone", () => {
    const currentTarget = {} as EventTarget;
    const overlayTarget = targetMatching("popover-content");
    expect(shouldIgnoreDataGridDetailNavigation(keyboardEvent({ target: overlayTarget, currentTarget }))).toBe(true);
    expect(shouldIgnoreDataGridDetailNavigation(keyboardEvent({ shiftKey: true }))).toBe(true);
    expect(shouldIgnoreDataGridDetailNavigation(keyboardEvent({ ctrlKey: true }))).toBe(true);
    expect(shouldIgnoreDataGridDetailNavigation(keyboardEvent({ defaultPrevented: true }))).toBe(true);
  });

  it("wires row and column intents to the displayed DataGrid order", () => {
    expect(detailDialogsSource).toContain('@keydown="onRowDetailKeydown"');
    expect(detailDialogsSource).toContain('@keydown="onColumnDetailKeydown"');
    expect(detailDialogsSource).toContain("shouldIgnoreDataGridDetailNavigation(event)");
    expect(detailDialogsSource).toContain('detailNavigationDelta(event.key, "row")');
    expect(detailDialogsSource).toContain('detailNavigationDelta(event.key, "column")');
    expect(detailDialogsSource).toContain('emit("navigateRow", delta)');
    expect(detailDialogsSource).toContain('emit("navigateColumn", delta)');
    expect(dataGridSource).toContain('@navigate-row="navigateRowDetail"');
    expect(dataGridSource).toContain('@navigate-column="navigateColumnDetail"');

    const rowNavigation = functionBody(dataGridSource, "navigateRowDetail", "navigateColumnDetail");
    const columnNavigation = functionBody(dataGridSource, "navigateColumnDetail", "openContextRowDetailDialog");

    expect(rowNavigation).toContain("displayRowIndexById(rowDetailDialogRowId.value)");
    expect(rowNavigation).toContain("displayItemAt(nextRowIndex)");
    expect(rowNavigation).not.toMatch(/rowDetailDialogRowId\.value\s*[+-]/);
    expect(columnNavigation).toContain("visibleColumnIndexes.value.indexOf(columnDetailDialogColumnIndex.value)");
    expect(columnNavigation).toContain("visibleColumnIndexes.value[nextColumnPosition]");
    expect(columnNavigation).not.toMatch(/columnDetailDialogColumnIndex\.value\s*[+-]/);
  });

  it("keeps the dialog open while replacing the detail target and guards closed dialogs", () => {
    const rowNavigation = functionBody(dataGridSource, "navigateRowDetail", "navigateColumnDetail");
    const columnNavigation = functionBody(dataGridSource, "navigateColumnDetail", "openContextRowDetailDialog");

    expect(rowNavigation).toContain("if (!rowDetailDialogOpen.value || rowDetailDialogRowId.value === null) return;");
    expect(columnNavigation).toContain("if (!columnDetailDialogOpen.value || columnDetailDialogColumnIndex.value === null) return;");
    expect(rowNavigation).not.toContain("rowDetailDialogOpen.value = false");
    expect(columnNavigation).not.toContain("columnDetailDialogOpen.value = false");
    expect(detailDialogsSource).toContain('const rowSearch = ref("");');
    expect(detailDialogsSource).toContain('const columnSearch = ref("");');
  });

  it("focuses the dialog content on open so arrows work immediately", () => {
    expect(detailDialogsSource).toContain('@open-auto-focus="focusDetailDialogContentOnOpen"');
    expect(detailDialogsSource).toContain('tabindex="-1"');
    expect(detailDialogsSource).toContain("function focusDetailDialogContentOnOpen(event: Event) {");
  });
});
