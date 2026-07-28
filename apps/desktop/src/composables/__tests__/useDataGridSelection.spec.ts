import { computed, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useDataGridSelection } from "@/composables/useDataGridSelection";

function createSelection(options?: { getScrollElement?: () => HTMLElement | null; cellFromClientPoint?: (clientX: number, clientY: number) => { rowIndex: number; colIndex: number } | null; rowFromClientPoint?: (clientX: number, clientY: number) => number | null; onUserCellSelection?: () => void }) {
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
    rowFromClientPoint: options?.rowFromClientPoint,
    onUserCellSelection: options?.onUserCellSelection,
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
  it("invalidates synthetic context state for ordinary, Ctrl, and Cmd cell selection", () => {
    const originalDocument = globalThis.document;
    const fakeDocument = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
    const onUserCellSelection = vi.fn();
    const selection = createSelection({ onUserCellSelection });
    const event = (options: { ctrlKey?: boolean; metaKey?: boolean } = {}) => ({ button: 0, clientX: 0, clientY: 0, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault: vi.fn(), ...options }) as unknown as MouseEvent;

    try {
      selection.handleDataCellMousedown(0, 0, 1, event());
      selection.finishCellSelection();
      selection.handleDataCellMousedown(0, 1, 1, event({ ctrlKey: true }));
      selection.handleDataCellMousedown(0, 2, 1, event({ metaKey: true }));

      expect(onUserCellSelection).toHaveBeenCalledTimes(3);
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
    }
  });

  it("describes a rectangular selection with its display row and column indexes", () => {
    const selection = createSelection();

    selection.selectSingleCell(1, 0);
    selection.extendCellSelectionTo(2, 1);

    expect(selection.selectedCellMatrix.value).toEqual({
      rowIndexes: [1, 2],
      columnIndexes: [0, 1],
      columns: ["id", "name"],
      rows: [
        [2, "name-2"],
        [3, "name-3"],
      ],
    });
  });

  it("supports non-contiguous columns when every selected row has the same columns", () => {
    const selection = createSelection();

    selection.selectedCellKeys.value = new Set(["0:0", "0:2", "2:0", "2:2"]);

    expect(selection.selectedCellMatrix.value).toEqual({
      rowIndexes: [0, 2],
      columnIndexes: [0, 2],
      columns: ["id", "email"],
      rows: [
        [1, "user-1@example.com"],
        [3, "user-3@example.com"],
      ],
    });
  });

  it("rejects discrete selections whose rows do not share the same columns", () => {
    const selection = createSelection();

    selection.selectedCellKeys.value = new Set(["0:0", "0:2", "2:0"]);

    expect(selection.selectedCellMatrix.value).toBeNull();
  });

  it("keeps contiguous row selections separate from cell ranges", () => {
    const selection = createSelection();

    selection.handleRowClick(1, 2, rowEvent({ meta: true }));
    selection.handleRowClick(2, 3, rowEvent({ meta: true }));
    selection.handleRowClick(3, 4, rowEvent({ meta: true }));

    expect(selection.selectedRowIds.value).toEqual(new Set([2, 3, 4]));
    expect(selection.selectedRange.value).toBeNull();
    expect(selection.hasCellSelection.value).toBe(false);
  });

  it("does not create a rectangular cell range for non-contiguous meta row selections", () => {
    const selection = createSelection();

    selection.handleRowClick(0, 1, rowEvent({ meta: true }));
    selection.handleRowClick(2, 3, rowEvent({ meta: true }));

    expect(selection.selectedRowIds.value).toEqual(new Set([1, 3]));
    expect(selection.selectedRange.value).toBeNull();
    expect(selection.hasCellSelection.value).toBe(false);
  });

  it("replaces disjoint rows with the anchored range on Shift selection", () => {
    const selection = createSelection();

    selection.handleRowClick(0, 1, rowEvent());
    selection.handleRowClick(3, 4, rowEvent({ meta: true }));
    selection.handleRowClick(1, 2, rowEvent({ shift: true }));

    expect(selection.selectedRowIds.value).toEqual(new Set([2, 3, 4]));
    expect(selection.hasCellSelection.value).toBe(false);
  });

  it("selects a continuous row range while dragging the row-number gutter", () => {
    const originalDocument = globalThis.document;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
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
    const animationFrames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;
    let pointerRow = 1;
    const selection = createSelection({ rowFromClientPoint: () => pointerRow });

    try {
      selection.beginRowSelection(1, 2, { button: 0, clientX: 5, clientY: 10, preventDefault() {} } as MouseEvent);
      pointerRow = 3;
      listeners.get("mousemove")?.forEach((listener) => {
        const event = { clientX: 5, clientY: 80 } as MouseEvent;
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      });
      animationFrames.shift()?.(0);

      expect(selection.selectedRowIds.value).toEqual(new Set([2, 3, 4]));
      expect(selection.hasCellSelection.value).toBe(false);
    } finally {
      selection.finishRowSelection();
      Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    }
  });

  it("keeps a meta-deselected row removed after pointer movement", () => {
    const originalDocument = globalThis.document;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
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
    globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;
    const selection = createSelection({ rowFromClientPoint: () => 1 });

    try {
      selection.selectedRowIds.value = new Set([1, 2, 3]);
      selection.beginRowSelection(1, 2, { button: 0, clientX: 5, clientY: 10, metaKey: true, preventDefault() {} } as MouseEvent);
      listeners.get("mousemove")?.forEach((listener) => {
        const event = { clientX: 6, clientY: 11 } as MouseEvent;
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      });

      expect(selection.selectedRowIds.value).toEqual(new Set([1, 3]));
    } finally {
      selection.finishRowSelection();
      Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    }
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
