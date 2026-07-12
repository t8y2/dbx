import { computed, nextTick, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { DATA_GRID_COL_AUTO_FIT_MAX_WIDTH, DATA_GRID_COL_MAX_WIDTH, DATA_GRID_COL_MIN_WIDTH } from "@/lib/dataGrid/dataGridColumnWidth";
import { DATA_GRID_ROW_NUM_WIDTH, resizeDataGridColumnWidth, useDataGridColumnResize } from "@/composables/useDataGridColumnResize";

function createResizeState(options: { columns: string[]; rows: Array<Array<string | number | boolean | null>>; columnIndexes?: number[]; density?: "compact" | "standard" | "comfortable"; compactColumnHeaderActions?: boolean }) {
  const compact = ref(options.compactColumnHeaderActions ?? true);
  const state = useDataGridColumnResize({
    columns: computed(() => options.columns),
    sourceRows: computed(() => options.rows),
    columnIndexes: computed(() => options.columnIndexes ?? options.columns.map((_, index) => index)),
    density: ref(options.density ?? "standard"),
    compactColumnHeaderActions: computed(() => compact.value),
  });
  return {
    ...state,
    setCompact(v: boolean) {
      compact.value = v;
    },
  };
}

describe("useDataGridColumnResize", () => {
  it("keeps compact query result columns at content width instead of filling the viewport", () => {
    const state = createResizeState({
      columns: ["id", "user_id"],
      rows: [
        [1, 10],
        [2, 20],
      ],
    });

    state.initColumnWidths();

    expect(state.renderedColumnWidths.value).toEqual(state.columnWidths.value);
    expect(state.totalWidth.value).toBe(DATA_GRID_ROW_NUM_WIDTH + state.columnWidths.value.reduce((total, width) => total + width, 0));
    expect(Math.max(...state.renderedColumnWidths.value)).toBeLessThan(200);
  });

  it("keeps default widths bounded but lets auto-fit use the wider cap", () => {
    const state = createResizeState({
      columns: ["description"],
      rows: [["x".repeat(120)]],
    });

    state.initColumnWidths();
    expect(state.columnWidths.value[0]).toBe(DATA_GRID_COL_MAX_WIDTH);

    state.autoFitColumn(0);

    expect(state.columnWidths.value[0]).toBeGreaterThan(DATA_GRID_COL_MAX_WIDTH);
    expect(state.columnWidths.value[0]).toBeLessThanOrEqual(DATA_GRID_COL_AUTO_FIT_MAX_WIDTH);
  });

  it("clamps manual column resizing to the minimum width", () => {
    expect(resizeDataGridColumnWidth(120, -200)).toBe(DATA_GRID_COL_MIN_WIDTH);
    expect(resizeDataGridColumnWidth(120, 30)).toBe(150);
  });

  it("publishes a fresh rendered width array when a column is resized", () => {
    const state = createResizeState({
      columns: ["id", "name"],
      rows: [[1, "Alice"]],
    });

    state.initColumnWidths();
    const before = state.renderedColumnWidths.value;

    state.columnWidths.value[1] = before[1] + 40;

    expect(state.renderedColumnWidths.value).not.toBe(before);
    expect(state.renderedColumnWidths.value[1]).toBe(before[1] + 40);
  });

  it("recalculates column widths when compactColumnHeaderActions changes", async () => {
    const state = createResizeState({
      columns: ["some_column_name_here"],
      rows: [["a"]],
      density: "compact",
      compactColumnHeaderActions: true,
    });

    state.initColumnWidths();
    const widthCompact = state.renderedColumnWidths.value[0];

    state.setCompact(false);
    await nextTick();

    const widthNonCompact = state.renderedColumnWidths.value[0];
    // compact: charWidth*nameLen + headerControlWidthCompact(20) = 7*21+20=167
    // non-compact: 7*21+headerControlWidth(36)=183
    expect(widthNonCompact).toBeGreaterThan(widthCompact);
  });
});
