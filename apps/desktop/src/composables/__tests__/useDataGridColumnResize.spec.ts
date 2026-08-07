// @vitest-environment happy-dom

import { computed, isRef, nextTick, ref } from "vue";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_GRID_COL_AUTO_FIT_MAX_WIDTH, DATA_GRID_COL_MIN_WIDTH, sampleDataGridColumnValues } from "@/lib/dataGrid/dataGridColumnWidth";
import { clearDataGridColumnWidthStates, createDataGridColumnMeasurementSignature, createDataGridColumnStructureSignature, DATA_GRID_COLUMN_WIDTH_STATE_LIMIT, dataGridColumnWidthStateCount, loadDataGridColumnWidthState, saveDataGridColumnWidthState } from "@/lib/dataGrid/dataGridColumnWidthState";
import { DATA_GRID_ROW_NUM_WIDTH, dataGridRowNumberColumnWidth, resizeDataGridColumnWidth, useDataGridColumnResize } from "@/composables/useDataGridColumnResize";

function createResizeState(options: {
  columns: string[];
  rows: Array<Array<string | number | boolean | null>> | ReturnType<typeof ref<Array<Array<string | number | boolean | null>>>>;
  columnIndexes?: number[];
  columnTypes?: string[];
  cacheKey?: string;
  density?: "compact" | "standard" | "comfortable";
  compactColumnHeaderActions?: boolean;
  indexIndicatorColumnIndexes?: number[] | ReturnType<typeof ref<number[]>>;
  headerTextWidth?: number;
}) {
  const compact = ref(options.compactColumnHeaderActions ?? true);
  const headerTextWidth = ref(options.headerTextWidth);
  const headerMeasurementKey = ref(0);
  const density = ref(options.density ?? "standard");
  const rows = isRef(options.rows) ? options.rows : ref(options.rows);
  const indexIndicatorColumnIndexes = isRef(options.indexIndicatorColumnIndexes) ? options.indexIndicatorColumnIndexes : ref(options.indexIndicatorColumnIndexes ?? []);
  const state = useDataGridColumnResize({
    columns: computed(() => options.columns),
    sourceRows: computed(() => rows.value),
    columnIndexes: computed(() => options.columnIndexes ?? options.columns.map((_, index) => index)),
    density,
    compactColumnHeaderActions: computed(() => compact.value),
    columnIndexIndicators: computed(() => options.columns.map((_, index) => indexIndicatorColumnIndexes.value.includes(index))),
    cacheKey: computed(() => options.cacheKey),
    columnStructureSignature: computed(() => createDataGridColumnStructureSignature(options.columns, options.columnTypes)),
    measureHeaderText: () => headerTextWidth.value,
    headerMeasurementKey,
  });
  return {
    ...state,
    rows,
    setCompact(v: boolean) {
      compact.value = v;
    },
    setDensity(value: "compact" | "standard" | "comfortable") {
      density.value = value;
    },
    setHeaderTextWidth(width: number) {
      headerTextWidth.value = width;
      headerMeasurementKey.value += 1;
    },
    setIndexIndicatorColumnIndexes(indexes: number[]) {
      indexIndicatorColumnIndexes.value = indexes;
    },
  };
}

describe("useDataGridColumnResize", () => {
  beforeEach(() => {
    clearDataGridColumnWidthStates();
  });

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
    // standard valueTextLimit=40, 120 chars → truncated to 40: 40×8+24+12=356
    // header "description"=11×8+59=147 < 356 → 356
    expect(state.columnWidths.value[0]).toBe(356);

    state.autoFitColumn(0);

    expect(state.columnWidths.value[0]).toBeGreaterThan(356);
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

  it("restores manually resized widths after a keyed result remount", () => {
    const first = createResizeState({
      columns: ["id", "name"],
      rows: [[1, "Alice"]],
      cacheKey: "result-a",
    });
    first.initColumnWidths();
    const originalWidth = first.columnWidths.value[1];

    first.onResizeStart(1, new MouseEvent("mousedown", { clientX: 100, cancelable: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 160 }));
    expect(first.columnWidths.value[1]).toBe(originalWidth + 60);
    const persisted = loadDataGridColumnWidthState(
      {
        cacheKey: "result-a",
        structureSignature: createDataGridColumnStructureSignature(["id", "name"]),
        measurementSignature: createDataGridColumnMeasurementSignature("standard", true, 0),
      },
      [0, 1],
    );
    expect(persisted?.userSizedColumnIndexes).toEqual(new Set([1]));

    const remounted = createResizeState({
      columns: ["id", "name"],
      rows: [[1, "Alice"]],
      cacheKey: "result-a",
    });
    remounted.initColumnWidths();

    expect(remounted.columnWidths.value).toEqual(first.columnWidths.value);
  });

  it("isolates widths by result cache key", () => {
    const first = createResizeState({ columns: ["id"], rows: [["x".repeat(120)]], cacheKey: "result-a" });
    first.initColumnWidths();
    first.autoFitColumn(0);

    const other = createResizeState({ columns: ["id"], rows: [[1]], cacheKey: "result-b" });
    other.initColumnWidths();

    expect(other.columnWidths.value[0]).not.toBe(first.columnWidths.value[0]);
  });

  it("rejects cached widths when the result column structure changes", () => {
    const first = createResizeState({ columns: ["id"], columnTypes: ["INT"], rows: [["x".repeat(120)]], cacheKey: "result-a" });
    first.initColumnWidths();
    first.autoFitColumn(0);

    const changed = createResizeState({ columns: ["id"], columnTypes: ["VARCHAR"], rows: [[1]], cacheKey: "result-a" });
    changed.initColumnWidths();

    expect(changed.columnWidths.value[0]).not.toBe(first.columnWidths.value[0]);
  });

  it("invalidates cached widths when density or font metrics change", async () => {
    const state = createResizeState({ columns: ["description"], rows: [["x".repeat(120)]], cacheKey: "result-a" });
    state.initColumnWidths();
    state.autoFitColumn(0);
    const fittedWidth = state.columnWidths.value[0];

    state.setDensity("compact");
    await nextTick();
    expect(state.columnWidths.value[0]).not.toBe(fittedWidth);

    state.autoFitColumn(0);
    state.setHeaderTextWidth(200);
    await nextTick();
    const remounted = createResizeState({ columns: ["description"], rows: [[1]], cacheKey: "result-a", density: "compact", headerTextWidth: 200 });
    remounted.initColumnWidths();
    expect(remounted.columnWidths.value[0]).not.toBe(fittedWidth);
  });

  it("evicts the least recently used width states at the cache limit", () => {
    const structureSignature = createDataGridColumnStructureSignature(["id"]);
    const measurementSignature = createDataGridColumnMeasurementSignature("standard", true, 14);
    for (let index = 0; index < DATA_GRID_COLUMN_WIDTH_STATE_LIMIT; index++) {
      saveDataGridColumnWidthState({ cacheKey: `result-${index}`, structureSignature, measurementSignature }, [0], [100 + index], new Set());
    }
    expect(loadDataGridColumnWidthState({ cacheKey: "result-0", structureSignature, measurementSignature }, [0])?.widths).toEqual([100]);
    saveDataGridColumnWidthState({ cacheKey: `result-${DATA_GRID_COLUMN_WIDTH_STATE_LIMIT}`, structureSignature, measurementSignature }, [0], [100 + DATA_GRID_COLUMN_WIDTH_STATE_LIMIT], new Set());

    expect(dataGridColumnWidthStateCount()).toBe(DATA_GRID_COLUMN_WIDTH_STATE_LIMIT);
    expect(loadDataGridColumnWidthState({ cacheKey: "result-1", structureSignature, measurementSignature }, [0])).toBeUndefined();
    expect(loadDataGridColumnWidthState({ cacheKey: "result-0", structureSignature, measurementSignature }, [0])?.widths).toEqual([100]);
    expect(loadDataGridColumnWidthState({ cacheKey: `result-${DATA_GRID_COLUMN_WIDTH_STATE_LIMIT}`, structureSignature, measurementSignature }, [0])?.widths).toEqual([100 + DATA_GRID_COLUMN_WIDTH_STATE_LIMIT]);
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

  it("grows a short column when its index indicator metadata arrives", async () => {
    const state = createResizeState({
      columns: ["id"],
      rows: [[1]],
      density: "compact",
      compactColumnHeaderActions: true,
    });
    state.initColumnWidths();
    expect(state.columnWidths.value[0]).toBe(60);

    state.setIndexIndicatorColumnIndexes([0]);
    await nextTick();

    expect(state.columnWidths.value[0]).toBe(75);
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
    // "short" = 5 chars → 5×8+24+12=76, header "data"=4×8+59=91 → max=91
    expect(state.columnWidths.value[0]).toBeLessThan(600);
    expect(state.columnWidths.value[0]).toBe(91);
  });

  it("sizes short numeric columns from large sample values", () => {
    const state = createResizeState({
      columns: ["id"],
      rows: Array.from({ length: 20 }, (_, index) => [1_217_001 + index]),
      density: "standard",
      compactColumnHeaderActions: true,
    });

    state.initColumnWidths();

    // "1217001" → 7×8+24+12=92, wider than header-only "id" (~75)
    expect(state.columnWidths.value[0]).toBeGreaterThanOrEqual(92);
  });

  it("grows cached narrow columns when later pages introduce larger values", async () => {
    const rows = ref<Array<Array<string | number | boolean | null>>>([[1], [2], [3]]);
    const state = createResizeState({
      columns: ["id"],
      rows,
      density: "standard",
      compactColumnHeaderActions: true,
      cacheKey: "result-grow",
    });

    state.initColumnWidths();
    const narrowWidth = state.columnWidths.value[0];

    rows.value = Array.from({ length: 20 }, (_, index) => [1_217_001 + index]);
    await nextTick();

    expect(state.columnWidths.value[0]).toBeGreaterThan(narrowWidth);
    expect(state.columnWidths.value[0]).toBeGreaterThanOrEqual(92);

    const remounted = createResizeState({
      columns: ["id"],
      rows: Array.from({ length: 20 }, () => ["x".repeat(40)]),
      density: "standard",
      compactColumnHeaderActions: true,
      cacheKey: "result-grow",
    });
    remounted.initColumnWidths();
    expect(remounted.columnWidths.value[0]).toBe(356);
  });

  it("grows when the width percentile changes without changing the maximum value length", async () => {
    const rows = ref<Array<Array<string | number | boolean | null>>>([...Array.from({ length: 49 }, () => ["x"]), ["x".repeat(40)]]);
    const state = createResizeState({
      columns: ["id"],
      rows,
      density: "standard",
      compactColumnHeaderActions: true,
    });

    state.initColumnWidths();
    expect(state.columnWidths.value[0]).toBe(75);

    rows.value = [["x"], ...Array.from({ length: 49 }, () => ["x".repeat(40)])];
    await nextTick();

    expect(state.columnWidths.value[0]).toBe(356);
  });

  it("preserves a manually narrowed width across page changes and remounts", async () => {
    const rows = ref<Array<Array<string | number | boolean | null>>>(Array.from({ length: 20 }, (_, index) => [1_217_001 + index]));
    const state = createResizeState({
      columns: ["id"],
      rows,
      density: "standard",
      compactColumnHeaderActions: true,
      cacheKey: "manual-narrow",
    });

    state.initColumnWidths();
    state.onResizeStart(0, new MouseEvent("mousedown", { clientX: 100, cancelable: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 0 }));
    expect(state.columnWidths.value[0]).toBe(DATA_GRID_COL_MIN_WIDTH);

    rows.value = Array.from({ length: 20 }, () => ["x".repeat(40)]);
    await nextTick();
    expect(state.columnWidths.value[0]).toBe(DATA_GRID_COL_MIN_WIDTH);

    const remounted = createResizeState({
      columns: ["id"],
      rows,
      density: "standard",
      compactColumnHeaderActions: true,
      cacheKey: "manual-narrow",
    });
    remounted.initColumnWidths();
    expect(remounted.columnWidths.value[0]).toBe(DATA_GRID_COL_MIN_WIDTH);
  });

  it("preserves an explicit auto-fit width across page changes and remounts", async () => {
    const rows = ref<Array<Array<string | number | boolean | null>>>([[1], [2], [3]]);
    const state = createResizeState({
      columns: ["id"],
      rows,
      density: "standard",
      compactColumnHeaderActions: true,
      cacheKey: "manual-auto-fit",
    });

    state.initColumnWidths();
    state.autoFitColumn(0);
    const fittedWidth = state.columnWidths.value[0];

    rows.value = Array.from({ length: 20 }, () => ["x".repeat(40)]);
    await nextTick();
    expect(state.columnWidths.value[0]).toBe(fittedWidth);

    const remounted = createResizeState({
      columns: ["id"],
      rows,
      density: "standard",
      compactColumnHeaderActions: true,
      cacheKey: "manual-auto-fit",
    });
    remounted.initColumnWidths();
    expect(remounted.columnWidths.value[0]).toBe(fittedWidth);
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

describe("sampleDataGridColumnValues", () => {
  it("includes both the head and tail of a long row window", () => {
    const rows = Array.from({ length: 100 }, (_, index) => [index + 1, `row-${index + 1}`]);
    expect(sampleDataGridColumnValues(rows, 0, 10)).toEqual([1, 2, 3, 4, 5, 96, 97, 98, 99, 100]);
  });
});

describe("dataGridRowNumberColumnWidth", () => {
  it("keeps the default width for small page indexes", () => {
    expect(dataGridRowNumberColumnWidth(999)).toBe(DATA_GRID_ROW_NUM_WIDTH);
    expect(dataGridRowNumberColumnWidth(9999)).toBe(DATA_GRID_ROW_NUM_WIDTH);
  });

  it("widens the gutter for multi-million row numbers", () => {
    expect(dataGridRowNumberColumnWidth(4_215_101)).toBeGreaterThan(DATA_GRID_ROW_NUM_WIDTH);
    expect(dataGridRowNumberColumnWidth(4_215_101)).toBe(dataGridRowNumberColumnWidth(9_999_999));
  });

  it("prefers measured text width when provided", () => {
    expect(dataGridRowNumberColumnWidth(99, 12, () => 40)).toBe(56);
  });
});
