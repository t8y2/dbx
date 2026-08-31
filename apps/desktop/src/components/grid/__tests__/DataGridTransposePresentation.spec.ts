import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid transpose presentation", () => {
  it("left-aligns record headers with their transposed values", () => {
    expect(dataGridSource).toContain('class="shrink-0 border-r border-border px-2 py-1.5 text-left tabular-nums relative"');
    expect(dataGridSource).not.toContain('class="shrink-0 border-r border-border px-2 py-1.5 text-center tabular-nums relative"');
  });

  it("shows field metadata only when the transpose setting is enabled", () => {
    expect(dataGridSource).toContain("settingsStore.editorSettings.dataGridShowTransposeFieldMetadata");
    expect(dataGridSource).toContain("showTransposeFieldMetadata.value && showColumnTypesInHeader.value");
    expect(dataGridSource).toContain("showTransposeFieldMetadata.value && showColumnCommentsInHeader.value");
    expect(dataGridSource).toContain("30 + (transposeReserveTypeLine.value ? 14 : 0) + (transposeReserveCommentLine.value ? 14 : 0)");
    expect(dataGridSource).toContain(':item-size="transposeRowHeight"');
    expect(dataGridSource).toContain("data-grid-transpose-type-line");
    expect(dataGridSource).toContain("data-grid-transpose-comment-line");
    expect(dataGridSource).toContain("data-grid-transpose-index-indicator");
    expect(dataGridSource).toContain("showColumnTypesInHeader && item.type");
    expect(dataGridSource).toContain("showColumnCommentsInHeader && item.comment");
    expect(dataGridSource).toContain("transposeColumnIndexKind(item.column)");
  });

  it("shows complete long metadata in a hoverable, bounded tooltip", () => {
    expect(dataGridSource).toContain("data-grid-transpose-field-tooltip");
    expect(dataGridSource).toContain(':text="transposeFieldTitle(item)"');
    expect(dataGridSource).toContain('side="right"');
    expect(dataGridSource).toContain("max-h-[min(20rem,calc(100vh-1rem))]");
    expect(dataGridSource).toContain("w-[min(24rem,calc(100vw-1rem))]");
    expect(dataGridSource).toContain("overflow-auto rounded-md");
    expect(dataGridSource).toContain("whitespace-pre-wrap break-words select-text");
    expect(dataGridSource).not.toContain("data-grid-transpose-field-popover");
  });

  it("stops clipping the cell while the long-text editor or readonly text selection is active", () => {
    // Transposed rows are compact (30px by default) while the expanded editor
    // grows well beyond that; the cell must switch to overflow-visible while the
    // editor / readonly text selection is active, mirroring the normal grid cell.
    expect(dataGridSource).toContain("'overflow-visible z-20 border-r-transparent': transposeCellEditorActive(cell.recordIndex, cell.valueIndex)");
    expect(dataGridSource).toContain("'overflow-hidden text-ellipsis whitespace-nowrap': !transposeCellEditorActive(cell.recordIndex, cell.valueIndex)");
    expect(dataGridSource).toContain("function transposeCellEditorActive");
    expect(dataGridSource).toContain("readonlyTextCellMatches(rowId, valueIndex)");
    // The transposed cell no longer unconditionally truncates (overflow: hidden),
    // which would crop the expanded editor below the compact row bounds.
    expect(dataGridSource).not.toContain('class="relative flex shrink-0 items-center border-r border-border/70 px-2 py-0 truncate"');
  });

  it("shares the normal grid cell's editor overlay contract while editing", () => {
    // Normal grid cells switch to the same overflow/z/border contract while the
    // cell editor or readonly text selection is active, so long-text editing
    // looks identical across both views.
    expect(dataGridSource).toContain("'overflow-visible z-20 border-r-transparent': (editingCell?.rowId === item.id && editingCell?.col === col.actualColIdx) || readonlyTextCellMatches(item.id, col.actualColIdx),");
    expect(dataGridSource).toContain("'overflow-hidden': !((editingCell?.rowId === item.id && editingCell?.col === col.actualColIdx) || readonlyTextCellMatches(item.id, col.actualColIdx)),");
  });
});
