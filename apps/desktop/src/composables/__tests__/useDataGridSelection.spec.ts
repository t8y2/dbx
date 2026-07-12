import { computed, ref } from "vue";
import { describe, expect, it } from "vitest";
import { useDataGridSelection } from "@/composables/useDataGridSelection";

function createSelection(options?: { getScrollElement?: () => HTMLElement | null; cellFromClientPoint?: (clientX: number, clientY: number) => { rowIndex: number; colIndex: number } | null }) {
  const columns = computed(() => ["id", "name", "email"]);
  const displayItems = computed(() =>
    [1, 2, 3, 4].map((id, index) => ({
      id,
      sourceIndex: index,
      data: [id, `name-${id}`, `user-${id}@example.com`],
      isNew: false,
      isDraft: false,
      isDeleted: false,
      isDirtyCol: [false, false, false],
      status: "clean",
    })),
  );

  return useDataGridSelection({
    columns,
    displayItems,
    editingCell: ref(null),
    showTranspose: ref(false),
    transposeRowIndex: ref(null),
    gridRef: ref(undefined),
    getScrollElement: options?.getScrollElement,
    cellFromClientPoint: options?.cellFromClientPoint,
  });
}

function rowEvent(options: { meta?: boolean; shift?: boolean } = {}): MouseEvent {
  return {
    metaKey: !!options.meta,
    ctrlKey: !!options.meta,
    shiftKey: !!options.shift,
  } as MouseEvent;
}

describe("useDataGridSelection", () => {
  it("creates a whole-row cell range for contiguous meta row selections", () => {
    const selection = createSelection();

    selection.handleRowClick(1, 2, rowEvent({ meta: true }));
    selection.handleRowClick(2, 3, rowEvent({ meta: true }));
    selection.handleRowClick(3, 4, rowEvent({ meta: true }));

    expect(selection.selectedRowIds.value).toEqual(new Set([2, 3, 4]));
    expect(selection.selectedRange.value).toEqual({
      startRow: 1,
      endRow: 3,
      startCol: 0,
      endCol: 2,
    });
    expect(selection.hasCellSelection.value).toBe(true);
  });

  it("does not create a rectangular cell range for non-contiguous meta row selections", () => {
    const selection = createSelection();

    selection.handleRowClick(0, 1, rowEvent({ meta: true }));
    selection.handleRowClick(2, 3, rowEvent({ meta: true }));

    expect(selection.selectedRowIds.value).toEqual(new Set([1, 3]));
    expect(selection.selectedRange.value).toBeNull();
    expect(selection.hasCellSelection.value).toBe(false);
  });

  it("scrolls and extends the selection while dragging near an edge", () => {
    const animationFrames: FrameRequestCallback[] = [];
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const originalDocument = globalThis.document;
    const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
    const fakeDocument = {
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        const handlers = listeners.get(type) ?? new Set();
        handlers.add(listener);
        listeners.set(type, handlers);
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        listeners.get(type)?.delete(listener);
      },
    } as Document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;

    const scroller = { scrollLeft: 0, scrollTop: 0 } as HTMLElement;
    scroller.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200, x: 0, y: 0, toJSON: () => ({}) });
    const selection = createSelection({
      getScrollElement: () => scroller,
      cellFromClientPoint: () => ({ rowIndex: scroller.scrollTop > 0 ? 3 : 0, colIndex: 2 }),
    });
    const event = { button: 0, clientX: 100, clientY: 100, preventDefault() {} } as MouseEvent;

    try {
      selection.beginCellSelection(0, 0, event);
      const moveEvent = { clientX: 295, clientY: 195 } as MouseEvent;
      listeners.get("mousemove")?.forEach((listener) => {
        if (typeof listener === "function") listener(moveEvent);
        else listener.handleEvent(moveEvent);
      });
      animationFrames.shift()?.(0);

      expect(scroller.scrollLeft).toBeGreaterThan(0);
      expect(scroller.scrollTop).toBeGreaterThan(0);
      expect(selection.selectedRange.value).toEqual({ startRow: 0, endRow: 3, startCol: 0, endCol: 2 });
    } finally {
      selection.finishCellSelection();
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
      Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
    }
  });
});
