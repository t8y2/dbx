// @vitest-environment happy-dom

import { effectScope, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dataGridColumnOffsets, dataGridHorizontalColumnWindow, useDataGridColumnLayout, useDataGridColumnLayoutState, type ColumnHeaderReferenceDragController } from "@/composables/useDataGridColumnLayout";
import { columnHeaderDragAutoScrollDelta, columnHeaderDropTargetIndex } from "@/lib/dataGrid/dataGridColumnHeaderInteraction";
import { loadDataGridColumnLayout, saveDataGridColumnLayout } from "@/lib/dataGrid/dataGridColumnLayoutStorage";

describe("useDataGridColumnLayout", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });
  afterEach(() => {
    window.dispatchEvent(new Event("blur"));
    document.querySelectorAll("[data-column-header-drag-preview]").forEach((element) => element.remove());
    vi.unstubAllGlobals();
  });
  it("builds cumulative offsets", () => {
    expect(dataGridColumnOffsets([80, 120, 60])).toEqual([0, 80, 200, 260]);
  });

  it("windows columns while preserving spacer widths", () => {
    const widths = [100, 100, 100, 100, 100];
    const offsets = dataGridColumnOffsets(widths);
    expect(dataGridHorizontalColumnWindow({ widths, offsets, columnCount: 5, scrollLeft: 250, viewportWidth: 100, rowNumberWidth: 40, bufferPx: 0 })).toEqual({ start: 2, end: 4, beforeWidth: 200, afterWidth: 100 });
  });

  it("returns an empty window without columns", () => {
    expect(dataGridHorizontalColumnWindow({ widths: [], offsets: [0], columnCount: 0, scrollLeft: 0, viewportWidth: 0, rowNumberWidth: 40, bufferPx: 900 })).toEqual({
      start: 0,
      end: 0,
      beforeWidth: 0,
      afterWidth: 0,
    });
  });

  it("accelerates column drag scrolling toward the viewport edges", () => {
    expect(columnHeaderDragAutoScrollDelta({ clientX: 100, viewportLeft: 0, viewportRight: 400 })).toBe(0);
    expect(columnHeaderDragAutoScrollDelta({ clientX: 32, viewportLeft: 0, viewportRight: 400 })).toBeLessThan(0);
    expect(columnHeaderDragAutoScrollDelta({ clientX: -10, viewportLeft: 0, viewportRight: 400 })).toBe(-24);
    expect(columnHeaderDragAutoScrollDelta({ clientX: 368, viewportLeft: 0, viewportRight: 400 })).toBeGreaterThan(0);
    expect(columnHeaderDragAutoScrollDelta({ clientX: 410, viewportLeft: 0, viewportRight: 400 })).toBe(24);
    expect(columnHeaderDragAutoScrollDelta({ clientX: 410, viewportLeft: 0, viewportRight: 400, maxStep: 0 })).toBe(0);
    expect(columnHeaderDragAutoScrollDelta({ clientX: 85, viewportLeft: 50, viewportRight: 100 })).toBeGreaterThan(0);
  });

  it("calculates drag targets after excluding the source column", () => {
    const state = {
      columnWidths: [100, 100, 100, 100],
      columnOffsets: [0, 100, 200, 300, 400],
    };

    expect(columnHeaderDropTargetIndex({ ...state, sourceVisibleIndex: 0, currentTargetIndex: 0, direction: 1, pointerContentX: 150 })).toBe(0);
    expect(columnHeaderDropTargetIndex({ ...state, sourceVisibleIndex: 0, currentTargetIndex: 0, direction: 1, pointerContentX: 151 })).toBe(1);
    expect(columnHeaderDropTargetIndex({ ...state, sourceVisibleIndex: 0, currentTargetIndex: 0, direction: 1, pointerContentX: 251 })).toBe(2);
    expect(columnHeaderDropTargetIndex({ ...state, sourceVisibleIndex: 3, currentTargetIndex: 3, direction: -1, pointerContentX: 250 })).toBe(3);
    expect(columnHeaderDropTargetIndex({ ...state, sourceVisibleIndex: 3, currentTargetIndex: 3, direction: -1, pointerContentX: 249 })).toBe(2);
  });

  it("uses the shifted column midpoint when reversing direction", () => {
    const state = {
      sourceVisibleIndex: 0,
      columnWidths: [100, 100, 100, 100],
      columnOffsets: [0, 100, 200, 300, 400],
    };

    expect(columnHeaderDropTargetIndex({ ...state, currentTargetIndex: 2, direction: -1, pointerContentX: 151 })).toBe(2);
    expect(columnHeaderDropTargetIndex({ ...state, currentTargetIndex: 2, direction: -1, pointerContentX: 150 })).toBe(2);
    expect(columnHeaderDropTargetIndex({ ...state, currentTargetIndex: 2, direction: -1, pointerContentX: 149 })).toBe(1);
    expect(columnHeaderDropTargetIndex({ ...state, currentTargetIndex: 1, direction: -1, pointerContentX: 51 })).toBe(1);
    expect(columnHeaderDropTargetIndex({ ...state, currentTargetIndex: 1, direction: -1, pointerContentX: 49 })).toBe(0);

    expect(columnHeaderDropTargetIndex({ ...state, sourceVisibleIndex: 3, currentTargetIndex: 1, direction: 1, pointerContentX: 249 })).toBe(1);
    expect(columnHeaderDropTargetIndex({ ...state, sourceVisibleIndex: 3, currentTargetIndex: 1, direction: 1, pointerContentX: 250 })).toBe(1);
    expect(columnHeaderDropTargetIndex({ ...state, sourceVisibleIndex: 3, currentTargetIndex: 1, direction: 1, pointerContentX: 251 })).toBe(2);
  });

  it("owns visibility, null-column toggles, and persisted ordering", () => {
    const scope = effectScope();
    const state = scope.run(() =>
      useDataGridColumnLayoutState({
        columns: ref(["id", "name", "empty"]),
        sourceColumns: ref(undefined),
        commentByColumn: ref(new Map()),
        displayableColumnIndexes: ref([0, 1, 2]),
        allNullColumnIndexes: ref([2]),
        columnOrderKeys: ref(["id\0\0", "name\0\0", "empty\0\0"]),
        layoutScopeKey: ref("test-layout"),
        tableScopeKey: ref(""),
      }),
    )!;

    state.toggleColumnVisibility(1);
    expect(state.visibleColumnIndexes.value).toEqual([0, 2]);
    state.toggleAllNullColumns();
    expect(state.visibleColumnIndexes.value).toEqual([0]);
    state.showAllColumns();
    expect(state.visibleColumnIndexes.value).toEqual([0, 1, 2]);
    state.persistColumnOrder([1, 0, 2]);
    expect(state.orderedDisplayableColumnIndexes.value).toEqual([1, 0, 2]);
    scope.stop();
  });

  it("reapplies a persisted null-column preference without losing manual visibility state", async () => {
    const scope = effectScope();
    const hideNullColumns = ref(true);
    const allNullColumnIndexes = ref([2]);
    const state = scope.run(() =>
      useDataGridColumnLayoutState({
        columns: ref(["id", "name", "empty"]),
        sourceColumns: ref(undefined),
        commentByColumn: ref(new Map()),
        displayableColumnIndexes: ref([0, 1, 2]),
        allNullColumnIndexes,
        columnOrderKeys: ref(["id\0\0", "name\0\0", "empty\0\0"]),
        layoutScopeKey: ref("persisted-null-layout"),
        tableScopeKey: ref(""),
        hideNullColumns,
        onHideNullColumnsChange: (value) => {
          hideNullColumns.value = value;
        },
      }),
    )!;

    expect(state.nullColumnsHidden.value).toBe(true);
    expect(state.visibleColumnIndexes.value).toEqual([0, 1]);

    state.toggleColumnVisibility(1);
    hideNullColumns.value = false;
    await nextTick();
    expect(state.visibleColumnIndexes.value).toEqual([0, 2]);

    hideNullColumns.value = true;
    await nextTick();
    expect(state.visibleColumnIndexes.value).toEqual([0]);

    allNullColumnIndexes.value = [];
    await nextTick();
    expect(state.nullColumnsHidden.value).toBe(true);
    expect(state.visibleColumnIndexes.value).toEqual([0, 2]);

    allNullColumnIndexes.value = [2];
    await nextTick();
    state.resetColumnVisibility([]);
    expect(state.visibleColumnIndexes.value).toEqual([0, 1]);

    state.toggleAllNullColumns();
    expect(hideNullColumns.value).toBe(false);
    expect(state.visibleColumnIndexes.value).toEqual([0, 1, 2]);
    scope.stop();
  });

  it("restores manually hidden columns after the grid scope is recreated", () => {
    const options = {
      columns: ref(["id", "name", "email"]),
      sourceColumns: ref(undefined),
      commentByColumn: ref(new Map()),
      displayableColumnIndexes: ref([0, 1, 2]),
      allNullColumnIndexes: ref([]),
      columnOrderKeys: ref(["id\0\0", "name\0\0", "email\0\0"]),
      layoutScopeKey: ref("visibility-recreated-layout"),
      tableScopeKey: ref(""),
    };
    const firstScope = effectScope();
    const firstState = firstScope.run(() => useDataGridColumnLayoutState(options))!;

    firstState.toggleColumnVisibility(1);
    firstScope.stop();

    const recreatedScope = effectScope();
    const recreatedState = recreatedScope.run(() => useDataGridColumnLayoutState(options))!;
    expect(recreatedState.visibleColumnIndexes.value).toEqual([0, 2]);
    recreatedState.showAllColumns();
    recreatedScope.stop();

    expect(JSON.parse(localStorage.getItem("dbx-data-grid-column-layout:visibility-recreated-layout")!)).toMatchObject({ hiddenKeys: [] });
  });

  it("show all clears hidden keys for fields missing from the current page", () => {
    const layoutScopeKey = "visibility-missing-field-layout";
    saveDataGridColumnLayout(layoutScopeKey, {
      orderKeys: [],
      hiddenKeys: ["goodsList\0\0"],
    });
    const scope = effectScope();
    const state = scope.run(() =>
      useDataGridColumnLayoutState({
        columns: ref(["id", "status"]),
        sourceColumns: ref(undefined),
        commentByColumn: ref(new Map()),
        displayableColumnIndexes: ref([0, 1]),
        allNullColumnIndexes: ref([]),
        columnOrderKeys: ref(["id\0\0", "status\0\0"]),
        layoutScopeKey: ref(layoutScopeKey),
        tableScopeKey: ref(""),
      }),
    )!;

    state.showAllColumns();
    scope.stop();

    expect(loadDataGridColumnLayout(layoutScopeKey)?.hiddenKeys).toEqual([]);
  });

  it("persists a null column when it is manually hidden after showing all columns", () => {
    const scope = effectScope();
    const state = scope.run(() =>
      useDataGridColumnLayoutState({
        columns: ref(["id", "empty"]),
        sourceColumns: ref(undefined),
        commentByColumn: ref(new Map()),
        displayableColumnIndexes: ref([0, 1]),
        allNullColumnIndexes: ref([1]),
        columnOrderKeys: ref(["id\0\0", "empty\0\0"]),
        layoutScopeKey: ref("visibility-null-column-layout"),
        tableScopeKey: ref(""),
        hideNullColumns: ref(true),
      }),
    )!;

    expect(state.visibleColumnIndexes.value).toEqual([0]);
    state.showAllColumns();
    state.toggleColumnVisibility(1);

    scope.stop();
    expect(JSON.parse(localStorage.getItem("dbx-data-grid-column-layout:visibility-null-column-layout")!)).toMatchObject({ hiddenKeys: ["empty\0\0"] });
  });

  it("returns ordered layout options with visibility state and reorders hidden fields", () => {
    const scope = effectScope();
    const state = scope.run(() =>
      useDataGridColumnLayoutState({
        columns: ref(["id", "status", "goodsList"]),
        sourceColumns: ref(undefined),
        commentByColumn: ref(new Map([["goodsList", "Line items"]])),
        displayableColumnIndexes: ref([0, 1, 2]),
        allNullColumnIndexes: ref([]),
        columnOrderKeys: ref(["id\0\0", "status\0\0", "goodsList\0\0"]),
        layoutScopeKey: ref("layout-options"),
        tableScopeKey: ref(""),
      }),
    )!;

    state.toggleColumnVisibility(2);
    state.moveDisplayableColumn(2, 1);

    expect(state.filteredColumnLayoutOptions("line")).toMatchObject([{ column: "goodsList", visible: false, displayPosition: 1 }]);
    expect(state.orderedDisplayableColumnIndexes.value).toEqual([0, 2, 1]);
    scope.stop();
  });

  it("uses grouped result comments in field filtering without name-map fallback", () => {
    const scope = effectScope();
    const state = scope.run(() =>
      useDataGridColumnLayoutState({
        columns: ref(["asin_url", "total"]),
        sourceColumns: ref(undefined),
        columnComments: ref(["asin亚马逊前台地址", undefined]),
        commentByColumn: ref(new Map([["total", "Wrong aggregate comment"]])),
        displayableColumnIndexes: ref([0, 1]),
        allNullColumnIndexes: ref([]),
        columnOrderKeys: ref(["asin_url\0\0", "total\0\0"]),
        layoutScopeKey: ref("grouped-result-comments"),
        tableScopeKey: ref(""),
      }),
    )!;

    expect(state.orderedColumnLayoutOptions.value.map((option) => option.comment)).toEqual(["asin亚马逊前台地址", undefined]);
    expect(state.filteredColumnLayoutOptions("亚马逊").map((option) => option.column)).toEqual(["asin_url"]);
    expect(state.filteredColumnLayoutOptions("wrong")).toEqual([]);
    scope.stop();
  });

  it("keeps a new resize active when the previous resize completion frame is pending", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        const frame = nextFrame++;
        frames.set(frame, callback);
        return frame;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((frame: number) => frames.delete(frame)),
    );

    const scope = effectScope();
    const layout = scope.run(() =>
      useDataGridColumnLayout({
        columnNames: ref(["id"]),
        visibleColumnIndexes: ref([0]),
        renderedColumnWidths: ref([100]),
        scrollLeft: ref(0),
        viewportWidth: ref(400),
        rowNumberWidth: 40,
      }),
    )!;

    layout.startColumnHeaderResize(0, new MouseEvent("mousedown"));
    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(frames.size).toBe(1);

    layout.startColumnHeaderResize(0, new MouseEvent("mousedown"));
    expect(frames.size).toBe(0);
    expect(layout.columnHeaderResizeActive.value).toBe(true);

    scope.stop();
  });

  it("commits column drag order and removes global interaction state on disposal", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 0;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const first = document.createElement("div");
    first.dataset.visibleColIndex = "0";
    first.getBoundingClientRect = () => ({ left: 0, width: 100, right: 100, top: 0, bottom: 20, height: 20, x: 0, y: 0, toJSON: () => ({}) });
    const second = document.createElement("div");
    second.dataset.visibleColIndex = "1";
    second.getBoundingClientRect = () => ({ left: 100, width: 100, right: 200, top: 0, bottom: 20, height: 20, x: 100, y: 0, toJSON: () => ({}) });
    const header = document.createElement("div");
    header.append(first, second);
    const persist = vi.fn();

    const scope = effectScope();
    const layout = scope.run(() =>
      useDataGridColumnLayout({
        columnNames: ref(["id", "name"]),
        visibleColumnIndexes: ref([0, 1]),
        renderedColumnWidths: ref([100, 100]),
        scrollLeft: ref(0),
        viewportWidth: ref(400),
        rowNumberWidth: 40,
        headerRef: ref(header),
        onPersistColumnOrder: persist,
      }),
    )!;

    layout.startColumnHeaderDrag(0, new PointerEvent("pointerdown", { button: 0, clientX: 20, clientY: 10 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 180, clientY: 10 }));
    expect(document.body.style.userSelect).toBe("none");
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 180, clientY: 10 }));
    expect(persist).toHaveBeenCalledWith([1, 0]);
    expect(document.body.style.userSelect).toBe("");

    layout.startColumnHeaderDrag(0, new PointerEvent("pointerdown", { button: 0, clientX: 20, clientY: 10 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 180, clientY: 10 }));
    scope.stop();
    expect(document.body.style.userSelect).toBe("");
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 180, clientY: 10 }));
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("delays rightward sibling previews until the dragged column reaches the target slot", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 0;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const header = document.createElement("div");
    for (let index = 0; index < 3; index++) {
      const column = document.createElement("div");
      column.dataset.visibleColIndex = String(index);
      column.getBoundingClientRect = () => ({ left: index * 100, width: 100, right: (index + 1) * 100, top: 0, bottom: 20, height: 20, x: index * 100, y: 0, toJSON: () => ({}) });
      header.append(column);
    }

    const scope = effectScope();
    const layout = scope.run(() =>
      useDataGridColumnLayout({
        columnNames: ref(["a", "b", "c"]),
        visibleColumnIndexes: ref([0, 1, 2]),
        renderedColumnWidths: ref([100, 100, 100]),
        scrollLeft: ref(0),
        viewportWidth: ref(300),
        rowNumberWidth: 0,
        headerRef: ref(header),
      }),
    )!;

    layout.startColumnHeaderDrag(0, new PointerEvent("pointerdown", { button: 0, clientX: 50, clientY: 10 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 120, clientY: 10 }));
    expect(layout.columnHeaderPreviewOffsets.value).toEqual([70, 0, 0]);

    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 150, clientY: 10 }));
    expect(layout.columnHeaderPreviewOffsets.value).toEqual([100, 0, 0]);

    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 151, clientY: 10 }));
    expect(layout.columnHeaderPreviewOffsets.value).toEqual([101, -100, 0]);

    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 150, clientY: 10 }));
    expect(layout.columnHeaderPreviewOffsets.value).toEqual([100, -100, 0]);

    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 51, clientY: 10 }));
    expect(layout.columnHeaderPreviewOffsets.value).toEqual([1, -100, 0]);

    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 49, clientY: 10 }));
    expect(layout.columnHeaderPreviewOffsets.value).toEqual([-1, 0, 0]);
    scope.stop();
  });

  it("keeps a detached drag preview after the source header leaves the virtual window", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 0;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const header = document.createElement("div");
    const source = document.createElement("div");
    source.dataset.visibleColIndex = "0";
    source.textContent = "source_column";
    source.getBoundingClientRect = () => ({ left: 40, width: 120, right: 160, top: 20, bottom: 50, height: 30, x: 40, y: 20, toJSON: () => ({}) });
    header.append(source);

    const scope = effectScope();
    const layout = scope.run(() =>
      useDataGridColumnLayout({
        columnNames: ref(["source_column", "target_column"]),
        visibleColumnIndexes: ref([0, 1]),
        renderedColumnWidths: ref([120, 120]),
        scrollLeft: ref(0),
        viewportWidth: ref(240),
        rowNumberWidth: 40,
        headerRef: ref(header),
      }),
    )!;

    layout.startColumnHeaderDrag(0, new PointerEvent("pointerdown", { button: 0, clientX: 80, clientY: 30 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 100, clientY: 30 }));
    const preview = document.body.querySelector<HTMLElement>("[data-column-header-drag-preview]");
    expect(preview?.textContent).toBe("source_column");
    expect(preview?.style.width).toBe("120px");

    source.remove();
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 360, clientY: 30 }));
    expect(document.body.querySelector("[data-column-header-drag-preview]")).toBe(preview);
    expect(preview?.style.transform).toBe("translateX(280px)");

    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 360, clientY: 30 }));
    expect(document.body.querySelector("[data-column-header-drag-preview]")).toBeNull();

    header.append(source);
    layout.startColumnHeaderDrag(0, new PointerEvent("pointerdown", { button: 0, clientX: 80, clientY: 30 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 100, clientY: 30 }));
    expect(document.body.querySelector("[data-column-header-drag-preview]")).not.toBeNull();
    window.dispatchEvent(new Event("blur"));
    expect(document.body.querySelector("[data-column-header-drag-preview]")).toBeNull();
    scope.stop();
  });

  it("auto-scrolls while dragging a column to the first and last positions", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        const frame = nextFrame++;
        frames.set(frame, callback);
        return frame;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((frame: number) => frames.delete(frame)),
    );

    const scroller = document.createElement("div");
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 220 },
      scrollWidth: { configurable: true, value: 500 },
    });
    scroller.getBoundingClientRect = () => ({ left: 0, width: 220, right: 220, top: 20, bottom: 200, height: 180, x: 0, y: 20, toJSON: () => ({}) });

    const header = document.createElement("div");
    for (let index = 0; index < 5; index++) {
      const column = document.createElement("div");
      column.dataset.visibleColIndex = String(index);
      column.getBoundingClientRect = () => ({ left: index * 100 - scroller.scrollLeft, width: 100, right: (index + 1) * 100 - scroller.scrollLeft, top: 0, bottom: 20, height: 20, x: index * 100 - scroller.scrollLeft, y: 0, toJSON: () => ({}) });
      header.append(column);
    }
    const persist = vi.fn();
    const syncScroll = vi.fn();
    const scope = effectScope();
    const layout = scope.run(() =>
      useDataGridColumnLayout({
        columnNames: ref(["a", "b", "c", "d", "e"]),
        visibleColumnIndexes: ref([0, 1, 2, 3, 4]),
        renderedColumnWidths: ref([100, 100, 100, 100, 100]),
        scrollLeft: ref(0),
        viewportWidth: ref(220),
        rowNumberWidth: 0,
        headerRef: ref(header),
        getScrollElement: () => scroller,
        onHorizontalScroll: syncScroll,
        onPersistColumnOrder: persist,
      }),
    )!;

    layout.startColumnHeaderDrag(0, new PointerEvent("pointerdown", { button: 0, clientX: 50, clientY: 10 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 218, clientY: 10 }));
    for (let iteration = 0; iteration < 30 && frames.size > 0; iteration++) {
      const [frame, callback] = frames.entries().next().value!;
      frames.delete(frame);
      callback(iteration * 16);
    }

    expect(scroller.scrollLeft).toBe(280);
    expect(syncScroll).toHaveBeenCalled();
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 218, clientY: 10 }));
    expect(persist).toHaveBeenCalledWith([1, 2, 3, 4, 0]);
    expect(frames.size).toBe(0);

    scroller.scrollLeft = 280;
    layout.startColumnHeaderDrag(4, new PointerEvent("pointerdown", { button: 0, clientX: 170, clientY: 10 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 2, clientY: 10 }));
    for (let iteration = 0; iteration < 30 && frames.size > 0; iteration++) {
      const [frame, callback] = frames.entries().next().value!;
      frames.delete(frame);
      callback(iteration * 16);
    }

    expect(scroller.scrollLeft).toBe(0);
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 2, clientY: 10 }));
    expect(persist).toHaveBeenLastCalledWith([4, 0, 1, 2, 3]);
    expect(frames.size).toBe(0);
    scope.stop();
  });

  it("switches to reference mode over the editor and drops without reordering", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 0;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const header = document.createElement("div");
    for (let index = 0; index < 2; index++) {
      const column = document.createElement("div");
      column.dataset.visibleColIndex = String(index);
      column.getBoundingClientRect = () => ({ left: index * 100, width: 100, right: (index + 1) * 100, top: 0, bottom: 20, height: 20, x: index * 100, y: 0, toJSON: () => ({}) });
      header.append(column);
    }
    const controller: ColumnHeaderReferenceDragController = {
      isOverEditorTarget: (clientX) => clientX > 300,
      onEnter: vi.fn(() => "id"),
      onMove: vi.fn(),
      onDrop: vi.fn(() => true),
      onCancel: vi.fn(),
    };
    const persist = vi.fn();
    const scope = effectScope();
    const layout = scope.run(() =>
      useDataGridColumnLayout({
        columnNames: ref(["id", "name"]),
        visibleColumnIndexes: ref([0, 1]),
        renderedColumnWidths: ref([100, 100]),
        scrollLeft: ref(0),
        viewportWidth: ref(400),
        rowNumberWidth: 40,
        headerRef: ref(header),
        onPersistColumnOrder: persist,
        columnReferenceDrag: controller,
      }),
    )!;

    layout.startColumnHeaderDrag(0, new PointerEvent("pointerdown", { button: 0, clientX: 50, clientY: 10 }));
    // 网格内：仍是重排序预览
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 120, clientY: 10 }));
    expect(controller.onEnter).not.toHaveBeenCalled();
    expect(document.body.querySelector("[data-column-header-drag-preview]")).not.toBeNull();

    // 进入编辑器区域：切换为引用模式，重排序预览移除
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 320, clientY: 10 }));
    expect(controller.onEnter).toHaveBeenCalledWith(0);
    expect(controller.onMove).toHaveBeenCalledWith(0, 320, 10);
    expect(document.body.querySelector("[data-column-header-drag-preview]")).toBeNull();
    expect(layout.columnHeaderPreviewOffsets.value).toEqual([0, 0]);

    // 在编辑器内释放：插入但不重排列
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 320, clientY: 10 }));
    expect(controller.onDrop).toHaveBeenCalledWith(0, 320, 10);
    expect(controller.onCancel).toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    scope.stop();
  });

  it("cancels the reference drag and restores reorder preview when leaving the editor", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 0;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const header = document.createElement("div");
    for (let index = 0; index < 2; index++) {
      const column = document.createElement("div");
      column.dataset.visibleColIndex = String(index);
      column.getBoundingClientRect = () => ({ left: index * 100, width: 100, right: (index + 1) * 100, top: 0, bottom: 20, height: 20, x: index * 100, y: 0, toJSON: () => ({}) });
      header.append(column);
    }
    const controller: ColumnHeaderReferenceDragController = {
      isOverEditorTarget: (clientX) => clientX > 300,
      onEnter: vi.fn(() => "id"),
      onMove: vi.fn(),
      onDrop: vi.fn(() => true),
      onCancel: vi.fn(),
    };
    const persist = vi.fn();
    const scope = effectScope();
    const layout = scope.run(() =>
      useDataGridColumnLayout({
        columnNames: ref(["id", "name"]),
        visibleColumnIndexes: ref([0, 1]),
        renderedColumnWidths: ref([100, 100]),
        scrollLeft: ref(0),
        viewportWidth: ref(400),
        rowNumberWidth: 40,
        headerRef: ref(header),
        onPersistColumnOrder: persist,
        columnReferenceDrag: controller,
      }),
    )!;

    layout.startColumnHeaderDrag(0, new PointerEvent("pointerdown", { button: 0, clientX: 50, clientY: 10 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 320, clientY: 10 }));
    expect(controller.onEnter).toHaveBeenCalledTimes(1);

    // 拖回网格：还原重排序预览，引用反馈被取消
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 120, clientY: 10 }));
    expect(controller.onCancel).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector("[data-column-header-drag-preview]")).not.toBeNull();

    // 拖出后释放（不在编辑器内）：整体取消，不重排也不插入
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 320, clientY: 10 }));
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 120, clientY: 10 }));
    expect(controller.onDrop).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    scope.stop();
  });

  it("keeps reorder mode when the controller refuses the reference drag", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 0;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const header = document.createElement("div");
    for (let index = 0; index < 2; index++) {
      const column = document.createElement("div");
      column.dataset.visibleColIndex = String(index);
      column.getBoundingClientRect = () => ({ left: index * 100, width: 100, right: (index + 1) * 100, top: 0, bottom: 20, height: 20, x: index * 100, y: 0, toJSON: () => ({}) });
      header.append(column);
    }
    const controller: ColumnHeaderReferenceDragController = {
      isOverEditorTarget: () => true,
      onEnter: vi.fn(() => null),
      onMove: vi.fn(),
      onDrop: vi.fn(() => true),
      onCancel: vi.fn(),
    };
    const persist = vi.fn();
    const scope = effectScope();
    const layout = scope.run(() =>
      useDataGridColumnLayout({
        columnNames: ref(["id", "name"]),
        visibleColumnIndexes: ref([0, 1]),
        renderedColumnWidths: ref([100, 100]),
        scrollLeft: ref(0),
        viewportWidth: ref(400),
        rowNumberWidth: 40,
        headerRef: ref(header),
        onPersistColumnOrder: persist,
        columnReferenceDrag: controller,
      }),
    )!;

    layout.startColumnHeaderDrag(0, new PointerEvent("pointerdown", { button: 0, clientX: 50, clientY: 10 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 320, clientY: 10 }));
    expect(controller.onEnter).toHaveBeenCalled();
    expect(controller.onMove).not.toHaveBeenCalled();
    expect(document.body.querySelector("[data-column-header-drag-preview]")).not.toBeNull();

    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 320, clientY: 10 }));
    expect(controller.onDrop).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalled();
    scope.stop();
  });

  it("cancels a plain reorder drag released outside both the grid and the editor", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 0;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const header = document.createElement("div");
    header.getBoundingClientRect = () => ({ left: 0, width: 200, right: 200, top: 0, bottom: 20, height: 20, x: 0, y: 0, toJSON: () => ({}) });
    for (let index = 0; index < 2; index++) {
      const column = document.createElement("div");
      column.dataset.visibleColIndex = String(index);
      column.getBoundingClientRect = () => ({ left: index * 100, width: 100, right: (index + 1) * 100, top: 0, bottom: 20, height: 20, x: index * 100, y: 0, toJSON: () => ({}) });
      header.append(column);
    }
    const controller: ColumnHeaderReferenceDragController = {
      isOverEditorTarget: () => false,
      onEnter: vi.fn(() => null),
      onMove: vi.fn(),
      onDrop: vi.fn(() => true),
      onCancel: vi.fn(),
    };
    const persist = vi.fn();
    const scope = effectScope();
    const layout = scope.run(() =>
      useDataGridColumnLayout({
        columnNames: ref(["id", "name"]),
        visibleColumnIndexes: ref([0, 1]),
        renderedColumnWidths: ref([100, 100]),
        scrollLeft: ref(0),
        viewportWidth: ref(400),
        rowNumberWidth: 40,
        headerRef: ref(header),
        onPersistColumnOrder: persist,
        columnReferenceDrag: controller,
      }),
    )!;

    layout.startColumnHeaderDrag(0, new PointerEvent("pointerdown", { button: 0, clientX: 50, clientY: 10 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 120, clientY: 10 }));
    // 释放点 (320, 500) 不在表头/滚动区，也不在编辑器内：整体取消
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 320, clientY: 500 }));
    expect(persist).not.toHaveBeenCalled();

    // 对照：网格内释放仍提交重排序
    layout.startColumnHeaderDrag(0, new PointerEvent("pointerdown", { button: 0, clientX: 50, clientY: 10 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 180, clientY: 10 }));
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 180, clientY: 10 }));
    expect(persist).toHaveBeenCalledWith([1, 0]);
    scope.stop();
  });

  it("blocks native selection and drag while dragging columns", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 0;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const header = document.createElement("div");
    const column = document.createElement("div");
    column.dataset.visibleColIndex = "0";
    column.getBoundingClientRect = () => ({ left: 0, width: 100, right: 100, top: 0, bottom: 20, height: 20, x: 0, y: 0, toJSON: () => ({}) });
    header.append(column);

    const scope = effectScope();
    const layout = scope.run(() =>
      useDataGridColumnLayout({
        columnNames: ref(["id", "name"]),
        visibleColumnIndexes: ref([0, 1]),
        renderedColumnWidths: ref([100, 100]),
        scrollLeft: ref(0),
        viewportWidth: ref(400),
        rowNumberWidth: 40,
        headerRef: ref(header),
      }),
    )!;

    layout.startColumnHeaderDrag(0, new PointerEvent("pointerdown", { button: 0, clientX: 50, clientY: 10 }));

    // 拖拽期间原生选择与拖拽启动被拦截
    const selectStart = new Event("selectstart", { cancelable: true });
    document.dispatchEvent(selectStart);
    expect(selectStart.defaultPrevented).toBe(true);
    const dragStart = new Event("dragstart", { cancelable: true });
    document.dispatchEvent(dragStart);
    expect(dragStart.defaultPrevented).toBe(true);

    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 150, clientY: 10 }));
    expect(document.body.style.userSelect).toBe("");

    // 手势结束后恢复原生效行为
    const laterSelect = new Event("selectstart", { cancelable: true });
    document.dispatchEvent(laterSelect);
    expect(laterSelect.defaultPrevented).toBe(false);
    scope.stop();
  });

  it("uses the edge after frozen columns as the left auto-scroll trigger", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        const frame = nextFrame++;
        frames.set(frame, callback);
        return frame;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((frame: number) => frames.delete(frame)),
    );

    const scroller = document.createElement("div");
    scroller.scrollLeft = 200;
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 400 },
      scrollWidth: { configurable: true, value: 800 },
    });
    scroller.getBoundingClientRect = () => ({ left: 0, width: 400, right: 400, top: 20, bottom: 200, height: 180, x: 0, y: 20, toJSON: () => ({}) });

    const header = document.createElement("div");
    const column = document.createElement("div");
    column.dataset.visibleColIndex = "2";
    column.getBoundingClientRect = () => ({ left: 240, width: 100, right: 340, top: 0, bottom: 20, height: 20, x: 240, y: 0, toJSON: () => ({}) });
    header.append(column);

    const scope = effectScope();
    const layout = scope.run(() =>
      useDataGridColumnLayout({
        columnNames: ref(["a", "b", "c", "d", "e", "f", "g"]),
        visibleColumnIndexes: ref([0, 1, 2, 3, 4, 5, 6]),
        renderedColumnWidths: ref([100, 100, 100, 100, 100, 100, 100]),
        scrollLeft: ref(200),
        viewportWidth: ref(400),
        rowNumberWidth: 40,
        frozenColumnCount: ref(2),
        headerRef: ref(header),
        getScrollElement: () => scroller,
      }),
    )!;

    layout.startColumnHeaderDrag(2, new PointerEvent("pointerdown", { button: 0, clientX: 260, clientY: 10 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 235, clientY: 10 }));
    const [frame, callback] = frames.entries().next().value!;
    frames.delete(frame);
    callback(0);

    expect(scroller.scrollLeft).toBeLessThan(200);
    scope.stop();
  });

  describe("frozen columns", () => {
    it("starts with frozenColumnCount of 0", () => {
      const scope = effectScope();
      const state = scope.run(() =>
        useDataGridColumnLayoutState({
          columns: ref(["id", "name", "email"]),
          sourceColumns: ref(undefined),
          commentByColumn: ref(new Map()),
          displayableColumnIndexes: ref([0, 1, 2]),
          allNullColumnIndexes: ref([]),
          columnOrderKeys: ref(["id\0\0", "name\0\0", "email\0\0"]),
          layoutScopeKey: ref("frozen-test-layout"),
          tableScopeKey: ref(""),
        }),
      )!;
      expect(state.frozenColumnCount.value).toBe(0);
      scope.stop();
    });

    it("freezeToColumn sets frozenColumnCount to visibleColIdx + 1", () => {
      const scope = effectScope();
      const state = scope.run(() =>
        useDataGridColumnLayoutState({
          columns: ref(["id", "name", "email"]),
          sourceColumns: ref(undefined),
          commentByColumn: ref(new Map()),
          displayableColumnIndexes: ref([0, 1, 2]),
          allNullColumnIndexes: ref([]),
          columnOrderKeys: ref(["id\0\0", "name\0\0", "email\0\0"]),
          layoutScopeKey: ref("frozen-test-layout-2"),
          tableScopeKey: ref(""),
        }),
      )!;

      state.freezeToColumn(0);
      expect(state.frozenColumnCount.value).toBe(1);

      state.freezeToColumn(2);
      expect(state.frozenColumnCount.value).toBe(3);

      scope.stop();
    });

    it("unfreezeAllColumns resets frozenColumnCount to 0", () => {
      const scope = effectScope();
      const state = scope.run(() =>
        useDataGridColumnLayoutState({
          columns: ref(["id", "name", "email"]),
          sourceColumns: ref(undefined),
          commentByColumn: ref(new Map()),
          displayableColumnIndexes: ref([0, 1, 2]),
          allNullColumnIndexes: ref([]),
          columnOrderKeys: ref(["id\0\0", "name\0\0", "email\0\0"]),
          layoutScopeKey: ref("frozen-test-layout-3"),
          tableScopeKey: ref(""),
        }),
      )!;

      state.freezeToColumn(1);
      expect(state.frozenColumnCount.value).toBe(2);

      state.unfreezeAllColumns();
      expect(state.frozenColumnCount.value).toBe(0);

      scope.stop();
    });

    it("persists frozenColumnCount to localStorage", () => {
      const scope = effectScope();
      const state = scope.run(() =>
        useDataGridColumnLayoutState({
          columns: ref(["id", "name", "email"]),
          sourceColumns: ref(undefined),
          commentByColumn: ref(new Map()),
          displayableColumnIndexes: ref([0, 1, 2]),
          allNullColumnIndexes: ref([]),
          columnOrderKeys: ref(["id\0\0", "name\0\0", "email\0\0"]),
          layoutScopeKey: ref("frozen-persist-layout"),
          tableScopeKey: ref(""),
        }),
      )!;

      state.freezeToColumn(1);
      const raw = localStorage.getItem("dbx-data-grid-frozen-columns:frozen-persist-layout");
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!)).toEqual({ version: 1, frozenCount: 2 });

      scope.stop();
    });

    it("removes localStorage key when unfreezing all columns", () => {
      const scope = effectScope();
      const state = scope.run(() =>
        useDataGridColumnLayoutState({
          columns: ref(["id", "name", "email"]),
          sourceColumns: ref(undefined),
          commentByColumn: ref(new Map()),
          displayableColumnIndexes: ref([0, 1, 2]),
          allNullColumnIndexes: ref([]),
          columnOrderKeys: ref(["id\0\0", "name\0\0", "email\0\0"]),
          layoutScopeKey: ref("frozen-remove-layout"),
          tableScopeKey: ref(""),
        }),
      )!;

      state.freezeToColumn(0);
      expect(localStorage.getItem("dbx-data-grid-frozen-columns:frozen-remove-layout")).not.toBeNull();

      state.unfreezeAllColumns();
      expect(localStorage.getItem("dbx-data-grid-frozen-columns:frozen-remove-layout")).toBeNull();

      scope.stop();
    });

    it("restores frozenColumnCount from localStorage on load", async () => {
      localStorage.setItem("dbx-data-grid-frozen-columns:frozen-restore-layout", JSON.stringify({ version: 1, frozenCount: 2 }));

      const scope = effectScope();
      const state = scope.run(() =>
        useDataGridColumnLayoutState({
          columns: ref(["id", "name", "email"]),
          sourceColumns: ref(undefined),
          commentByColumn: ref(new Map()),
          displayableColumnIndexes: ref([0, 1, 2]),
          allNullColumnIndexes: ref([]),
          columnOrderKeys: ref(["id\0\0", "name\0\0", "email\0\0"]),
          layoutScopeKey: ref("frozen-restore-layout"),
          tableScopeKey: ref(""),
        }),
      )!;

      await nextTick();
      expect(state.frozenColumnCount.value).toBe(2);

      scope.stop();
    });

    it("restores the pre-freeze order after reload before unfreezing selected columns", async () => {
      const options = {
        columns: ref(["id", "name", "email"]),
        sourceColumns: ref(undefined),
        commentByColumn: ref(new Map()),
        displayableColumnIndexes: ref([0, 1, 2]),
        allNullColumnIndexes: ref([]),
        columnOrderKeys: ref(["id\0\0", "name\0\0", "email\0\0"]),
        layoutScopeKey: ref("frozen-reload-layout"),
        tableScopeKey: ref(""),
      };
      const firstScope = effectScope();
      const firstState = firstScope.run(() => useDataGridColumnLayoutState(options))!;

      firstState.freezeSelectedColumns([2]);
      expect(firstState.orderedDisplayableColumnIndexes.value).toEqual([2, 0, 1]);
      firstScope.stop();

      const reloadedScope = effectScope();
      const reloadedState = reloadedScope.run(() => useDataGridColumnLayoutState(options))!;
      await nextTick();
      reloadedState.unfreezeAllColumns();

      expect(reloadedState.frozenColumnCount.value).toBe(0);
      expect(reloadedState.orderedDisplayableColumnIndexes.value).toEqual([0, 1, 2]);
      reloadedScope.stop();
    });

    it("shrinks the persisted frozen count when visible columns are hidden", async () => {
      const scope = effectScope();
      const state = scope.run(() =>
        useDataGridColumnLayoutState({
          columns: ref(["id", "name", "email"]),
          sourceColumns: ref(undefined),
          commentByColumn: ref(new Map()),
          displayableColumnIndexes: ref([0, 1, 2]),
          allNullColumnIndexes: ref([]),
          columnOrderKeys: ref(["id\0\0", "name\0\0", "email\0\0"]),
          layoutScopeKey: ref("frozen-hidden-layout"),
          tableScopeKey: ref(""),
        }),
      )!;

      state.freezeToColumn(2);
      state.toggleColumnVisibility(1);
      await nextTick();

      expect(state.frozenColumnCount.value).toBe(2);
      expect(JSON.parse(localStorage.getItem("dbx-data-grid-frozen-columns:frozen-hidden-layout")!)).toMatchObject({ frozenCount: 2 });
      scope.stop();
    });

    it("allows changing frozen count from one value to another", () => {
      const scope = effectScope();
      const state = scope.run(() =>
        useDataGridColumnLayoutState({
          columns: ref(["id", "name", "email", "phone"]),
          sourceColumns: ref(undefined),
          commentByColumn: ref(new Map()),
          displayableColumnIndexes: ref([0, 1, 2, 3]),
          allNullColumnIndexes: ref([]),
          columnOrderKeys: ref(["id\0\0", "name\0\0", "email\0\0", "phone\0\0"]),
          layoutScopeKey: ref("frozen-change-layout"),
          tableScopeKey: ref(""),
        }),
      )!;

      state.freezeToColumn(1);
      expect(state.frozenColumnCount.value).toBe(2);

      // 增加冻结列数
      state.freezeToColumn(3);
      expect(state.frozenColumnCount.value).toBe(4);

      // 减少冻结列数
      state.freezeToColumn(0);
      expect(state.frozenColumnCount.value).toBe(1);

      scope.stop();
    });
  });
});
