// @vitest-environment happy-dom

import { effectScope, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dataGridColumnOffsets, dataGridHorizontalColumnWindow, useDataGridColumnLayout, useDataGridColumnLayoutState } from "@/composables/useDataGridColumnLayout";

describe("useDataGridColumnLayout", () => {
  beforeEach(() => localStorage.clear());
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
        return 1;
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
});
