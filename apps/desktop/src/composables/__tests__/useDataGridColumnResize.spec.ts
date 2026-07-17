import { computed, nextTick, ref } from "vue";
import { describe, expect, it } from "vitest";
import { DATA_GRID_COL_AUTO_FIT_MAX_WIDTH, DATA_GRID_COL_MIN_WIDTH } from "@/lib/dataGrid/dataGridColumnWidth";
import { DATA_GRID_ROW_NUM_WIDTH, resizeDataGridColumnWidth, useDataGridColumnResize } from "@/composables/useDataGridColumnResize";

function createResizeState(options: { columns: string[]; rows: Array<Array<string | number | boolean | null>>; columnIndexes?: number[]; density?: "compact" | "standard" | "comfortable"; compactColumnHeaderActions?: boolean; headerTextWidth?: number }) {
  const compact = ref(options.compactColumnHeaderActions ?? true);
  const headerTextWidth = ref(options.headerTextWidth);
  const headerMeasurementKey = ref(0);
  const state = useDataGridColumnResize({
    columns: computed(() => options.columns),
    sourceRows: computed(() => options.rows),
    columnIndexes: computed(() => options.columnIndexes ?? options.columns.map((_, index) => index)),
    density: ref(options.density ?? "standard"),
    compactColumnHeaderActions: computed(() => compact.value),
    measureHeaderText: () => headerTextWidth.value,
    headerMeasurementKey,
  });
  return {
    ...state,
    setCompact(v: boolean) {
      compact.value = v;
    },
    setHeaderTextWidth(width: number) {
      headerTextWidth.value = width;
      headerMeasurementKey.value += 1;
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
    // standard valueTextLimit=40, 120 chars → truncated to 40: 40×8+24=344
    // header "description"=11×8+85=173 < 344 → 344
    expect(state.columnWidths.value[0]).toBe(344);

    state.autoFitColumn(0);

    expect(state.columnWidths.value[0]).toBeGreaterThan(344);
    expect(state.columnWidths.value[0]).toBeLessThanOrEqual(DATA_GRID_COL_AUTO_FIT_MAX_WIDTH);
  });

  it("includes values when explicitly auto-fitting a compact column", () => {
    const state = createResizeState({
      columns: ["id"],
      rows: [["x".repeat(120)]],
      density: "compact",
    });

    state.initColumnWidths();
    expect(state.columnWidths.value[0]).toBe(60);

    state.autoFitColumn(0);

    expect(state.columnWidths.value[0]).toBeGreaterThan(60);
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
      density: "standard",
      compactColumnHeaderActions: true,
    });

    state.initColumnWidths();
    const widthCompact = state.renderedColumnWidths.value[0];

    state.setCompact(false);
    await nextTick();

    const widthNonCompact = state.renderedColumnWidths.value[0];
    // standard compactActions=true: 21×8+59=227
    // standard compactActions=false: 21×8+83=251
    expect(widthNonCompact).toBeGreaterThan(widthCompact);
  });

  it("recalculates column widths when rendered header font metrics change", async () => {
    const state = createResizeState({
      columns: ["AMOUNT"],
      rows: [[1]],
      density: "comfortable",
      compactColumnHeaderActions: true,
      headerTextWidth: 54,
    });

    state.initColumnWidths();
    expect(state.columnWidths.value[0]).toBe(113);

    state.setHeaderTextWidth(70);
    await nextTick();

    expect(state.columnWidths.value[0]).toBe(129);
  });

  it("compact mode keeps normal field names complete and caps pathological names", () => {
    // 短字段名：列宽=字段名宽度，值不参与撑宽
    const short = createResizeState({
      columns: ["id"],
      rows: [["x".repeat(100)]],
      density: "compact",
      compactColumnHeaderActions: true,
    });
    short.initColumnWidths();
    // "id"=2×7+45=59 < min 60 → 60
    expect(short.columnWidths.value[0]).toBe(60);

    // 中等字段名：刚好完整显示
    const mid = createResizeState({
      columns: ["user_name"],
      rows: [["a"]],
      density: "compact",
      compactColumnHeaderActions: true,
    });
    mid.initColumnWidths();
    // 9×7+45=108
    expect(mid.columnWidths.value[0]).toBe(108);

    // 异常超长字段名：使用独立表头上限，避免单列撑爆表格
    const longName = createResizeState({
      columns: ["x".repeat(100)],
      rows: [["a"]],
      density: "compact",
      compactColumnHeaderActions: true,
    });
    longName.initColumnWidths();
    // 100×7+45=745，表头自动宽度限制为 500
    expect(longName.columnWidths.value[0]).toBe(500);
  });

  it("comfortable mode uses percentile to ignore outlier values", () => {
    const shortRows = Array.from({ length: 49 }, () => ["short"]);
    const rows = [...shortRows, ["x".repeat(200)]];

    const state = createResizeState({
      columns: ["data"],
      rows,
      density: "comfortable",
      compactColumnHeaderActions: true,
    });

    state.initColumnWidths();
    // P95 of 50 samples ignores the single 200-char outlier;
    // "short" = 5 chars → 5×8+24=64, header "data"=4×8+59=91 → max=91
    expect(state.columnWidths.value[0]).toBeLessThan(600);
    expect(state.columnWidths.value[0]).toBe(91);
  });

  it("comfortable mode is never narrower than standard for the same column", () => {
    const rows = Array.from({ length: 50 }, () => ["medium_value"]);

    const std = createResizeState({
      columns: ["description"],
      rows,
      density: "standard",
      compactColumnHeaderActions: true,
    });
    std.initColumnWidths();

    const comf = createResizeState({
      columns: ["description"],
      rows,
      density: "comfortable",
      compactColumnHeaderActions: true,
    });
    comf.initColumnWidths();

    expect(comf.columnWidths.value[0]).toBeGreaterThanOrEqual(std.columnWidths.value[0]);
  });
});
