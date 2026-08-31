import { computed, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useDataGridSelection } from "@/composables/useDataGridSelection";

function createSelection(options?: {
  getScrollElement?: () => HTMLElement | null;
  cellFromClientPoint?: (clientX: number, clientY: number) => { rowIndex: number; colIndex: number } | null;
  rowFromClientPoint?: (clientX: number, clientY: number) => number | null;
  onUserCellSelection?: () => void;
  shouldUpdateDraggedRowsImmediately?: () => boolean;
  onDraggedRowSelectionChange?: () => void;
}) {
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
    shouldUpdateDraggedRowsImmediately: options?.shouldUpdateDraggedRowsImmediately,
    onDraggedRowSelectionChange: options?.onDraggedRowSelectionChange,
  });
}

function rowEvent(options: { meta?: boolean; shift?: boolean } = {}): MouseEvent {
  return {
    metaKey: !!options.meta,
    ctrlKey: !!options.meta,
    shiftKey: !!options.shift,
  } as MouseEvent;
}

function installPointerDocument() {
  const originalDocument = globalThis.document;
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const windowListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const animationFrames: FrameRequestCallback[] = [];
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
  const fakeWindow = {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const handlers = windowListeners.get(type) ?? new Set();
      handlers.add(listener);
      windowListeners.set(type, handlers);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      windowListeners.get(type)?.delete(listener);
    },
  } as Window;
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;

  return {
    animationFrames,
    dispatch(type: string, event: MouseEvent) {
      listeners.get(type)?.forEach((listener) => {
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      });
    },
    dispatchWindow(type: string, event: Event = { type } as Event) {
      windowListeners.get(type)?.forEach((listener) => {
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      });
    },
    restore() {
      Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
      if (originalWindowDescriptor) Object.defineProperty(globalThis, "window", originalWindowDescriptor);
      else Reflect.deleteProperty(globalThis, "window");
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    },
  };
}

describe("useDataGridSelection", () => {
  it("keeps selected columns and the range anchor attached to their columns after reordering", () => {
    const selection = createSelection();

    selection.selectColumn(0);
    selection.selectColumn(2, rowEvent({ meta: true }));
    selection.reconcileSelectionAfterColumnReorder([0, 1, 2], [1, 2, 0]);

    expect(selection.selectedColumnIndexes.value).toEqual(new Set([1, 2]));

    selection.selectColumn(0, rowEvent({ shift: true }));
    expect(selection.selectedColumnIndexes.value).toEqual(new Set([0, 1, 2]));
  });

  it("moves a single-column rectangular cell selection with its column after reordering", () => {
    const selection = createSelection();

    selection.selectSingleCell(1, 0);
    selection.extendCellSelectionTo(2, 0);
    selection.reconcileSelectionAfterColumnReorder([0, 1, 2], [1, 2, 0]);

    expect(selection.selectedRange.value).toEqual({ startRow: 1, endRow: 2, startCol: 2, endCol: 2 });
    expect(selection.cellIsSelected(1, 2)).toBe(true);
    expect(selection.cellIsSelected(2, 0)).toBe(false);
  });

  it("moves a discrete single-column cell selection with its column after reordering", () => {
    const selection = createSelection();

    selection.selectedCellKeys.value = new Set(["0:0", "2:0"]);
    selection.reconcileSelectionAfterColumnReorder([0, 1, 2], [1, 2, 0]);

    expect(selection.selectedCellKeys.value).toEqual(new Set(["0:2", "2:2"]));
    expect(selection.cellIsSelected(0, 2)).toBe(true);
    expect(selection.cellIsSelected(2, 0)).toBe(false);
  });

  it("keeps a multi-column rectangular cell selection when its columns remain contiguous", () => {
    const selection = createSelection();

    selection.selectSingleCell(1, 0);
    selection.extendCellSelectionTo(2, 1);
    selection.reconcileSelectionAfterColumnReorder([0, 1, 2], [2, 0, 1]);

    expect(selection.selectedRange.value).toEqual({ startRow: 1, endRow: 2, startCol: 1, endCol: 2 });
    expect(selection.cellIsSelected(1, 1)).toBe(true);
    expect(selection.cellIsSelected(2, 2)).toBe(true);
    expect(selection.cellIsSelected(1, 0)).toBe(false);
  });

  it.each([
    { edge: "left", nextColumnIndexes: [1, 0, 2] },
    { edge: "right", nextColumnIndexes: [0, 2, 1] },
  ])("keeps the whole rectangular selection when an inner column moves to its $edge edge", ({ nextColumnIndexes }) => {
    const selection = createSelection();

    selection.selectSingleCell(1, 0);
    selection.extendCellSelectionTo(2, 2);
    selection.reconcileSelectionAfterColumnReorder([0, 1, 2], nextColumnIndexes);

    expect(selection.selectedRange.value).toEqual({ startRow: 1, endRow: 2, startCol: 0, endCol: 2 });
    expect(selection.cellIsSelected(1, nextColumnIndexes.indexOf(1))).toBe(true);
    expect(selection.selectedCellCount.value).toBe(6);
  });

  it("clears a multi-column rectangular cell selection when its columns split apart", () => {
    const selection = createSelection();

    selection.selectSingleCell(1, 0);
    selection.extendCellSelectionTo(2, 1);
    selection.reconcileSelectionAfterColumnReorder([0, 1, 2], [1, 2, 0]);

    expect(selection.selectedRange.value).toBeNull();
    expect(selection.selectedCellKeys.value).toEqual(new Set());
    expect(selection.hasCellSelection.value).toBe(false);
  });

  it("keeps a discrete multi-column cell selection when its columns become contiguous", () => {
    const selection = createSelection();

    selection.selectedCellKeys.value = new Set(["0:0", "0:2", "2:0", "2:2"]);
    selection.reconcileSelectionAfterColumnReorder([0, 1, 2], [1, 2, 0]);

    expect(selection.selectedCellKeys.value).toEqual(new Set(["0:2", "0:1", "2:2", "2:1"]));
    expect(selection.cellIsSelected(0, 1)).toBe(true);
    expect(selection.cellIsSelected(2, 2)).toBe(true);
    expect(selection.cellIsSelected(0, 0)).toBe(false);
  });

  it("clears a discrete multi-column cell selection when its columns split apart", () => {
    const selection = createSelection();

    selection.selectedCellKeys.value = new Set(["0:0", "0:1", "2:0", "2:1"]);
    selection.reconcileSelectionAfterColumnReorder([0, 1, 2], [1, 2, 0]);

    expect(selection.selectedRange.value).toBeNull();
    expect(selection.selectedCellKeys.value).toEqual(new Set());
    expect(selection.hasCellSelection.value).toBe(false);
  });

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

  it("ignores cell jitter until the drag threshold and exposes confirmation for hover extension", () => {
    const pointerDocument = installPointerDocument();
    const selection = createSelection({ cellFromClientPoint: () => ({ rowIndex: 2, colIndex: 2 }) });

    try {
      selection.beginCellSelection(0, 0, { button: 0, clientX: 100, clientY: 100, preventDefault() {} } as MouseEvent);
      pointerDocument.dispatch("mousemove", { clientX: 111, clientY: 100 } as MouseEvent);
      if (selection.isCellSelectionDragConfirmed()) selection.extendCellSelection(2, 2);

      expect(selection.isCellSelectionDragConfirmed()).toBe(false);
      expect(selection.selectedRange.value).toEqual({ startRow: 0, endRow: 0, startCol: 0, endCol: 0 });

      pointerDocument.dispatch("mousemove", { clientX: 112, clientY: 100 } as MouseEvent);

      expect(selection.isCellSelectionDragConfirmed()).toBe(true);
      expect(selection.selectedRange.value).toEqual({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 });
    } finally {
      selection.finishCellSelection();
      pointerDocument.restore();
    }
  });

  it("does not extend an unconfirmed cell drag on mouseup", () => {
    const pointerDocument = installPointerDocument();
    const selection = createSelection({ cellFromClientPoint: () => ({ rowIndex: 2, colIndex: 2 }) });

    try {
      selection.beginCellSelection(0, 0, { button: 0, clientX: 100, clientY: 100, preventDefault() {} } as MouseEvent);
      pointerDocument.dispatch("mousemove", { clientX: 111, clientY: 100 } as MouseEvent);
      pointerDocument.dispatch("mouseup", { clientX: 111, clientY: 100 } as MouseEvent);

      expect(selection.isSelectingCells.value).toBe(false);
      expect(selection.selectedRange.value).toEqual({ startRow: 0, endRow: 0, startCol: 0, endCol: 0 });
    } finally {
      selection.finishCellSelection();
      pointerDocument.restore();
    }
  });

  it("ignores row gutter jitter until the drag threshold", () => {
    const pointerDocument = installPointerDocument();
    const selection = createSelection({ rowFromClientPoint: () => 3 });

    try {
      selection.beginRowSelection(1, 2, { button: 0, clientX: 100, clientY: 100, preventDefault() {} } as MouseEvent);
      pointerDocument.dispatch("mousemove", { clientX: 111, clientY: 100 } as MouseEvent);

      expect(selection.selectedRowIds.value).toEqual(new Set([2]));

      pointerDocument.dispatch("mousemove", { clientX: 112, clientY: 100 } as MouseEvent);
      pointerDocument.animationFrames.shift()?.(0);

      expect(selection.selectedRowIds.value).toEqual(new Set([2, 3, 4]));
    } finally {
      selection.finishRowSelection();
      pointerDocument.restore();
    }
  });

  it("does not extend an unconfirmed row gutter drag on mouseup", () => {
    const pointerDocument = installPointerDocument();
    const selection = createSelection({ rowFromClientPoint: () => 3 });

    try {
      selection.beginRowSelection(1, 2, { button: 0, clientX: 100, clientY: 100, preventDefault() {} } as MouseEvent);
      pointerDocument.dispatch("mouseup", { clientX: 111, clientY: 100 } as MouseEvent);

      expect(selection.isSelectingRows.value).toBe(false);
      expect(selection.selectedRowIds.value).toEqual(new Set([2]));
    } finally {
      selection.finishRowSelection();
      pointerDocument.restore();
    }
  });

  it("ends active cell and row drags when the window loses focus", () => {
    const pointerDocument = installPointerDocument();
    let pointerRow = 2;
    let pointerCell = { rowIndex: 2, colIndex: 2 };
    const selection = createSelection({
      cellFromClientPoint: () => pointerCell,
      rowFromClientPoint: () => pointerRow,
      shouldUpdateDraggedRowsImmediately: () => true,
    });

    try {
      selection.beginCellSelection(0, 0, { button: 0, clientX: 10, clientY: 10, preventDefault() {} } as MouseEvent);
      pointerDocument.dispatch("mousemove", { buttons: 1, clientX: 30, clientY: 30 } as MouseEvent);
      expect(selection.selectedRange.value).toEqual({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 });

      pointerDocument.dispatchWindow("blur");
      expect(selection.isSelectingCells.value).toBe(false);
      pointerCell = { rowIndex: 3, colIndex: 2 };
      pointerDocument.dispatch("mousemove", { buttons: 1, clientX: 40, clientY: 40 } as MouseEvent);
      expect(selection.selectedRange.value).toEqual({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 });

      selection.beginRowSelection(1, 2, { button: 0, clientX: 5, clientY: 10, preventDefault() {} } as MouseEvent);
      pointerDocument.dispatch("mousemove", { buttons: 1, clientX: 5, clientY: 40 } as MouseEvent);
      expect(selection.selectedRowIds.value).toEqual(new Set([2, 3]));

      pointerDocument.dispatchWindow("blur");
      expect(selection.isSelectingRows.value).toBe(false);
      pointerRow = 3;
      pointerDocument.dispatch("mousemove", { buttons: 1, clientX: 5, clientY: 70 } as MouseEvent);
      expect(selection.selectedRowIds.value).toEqual(new Set([2, 3]));
    } finally {
      selection.finishCellSelection();
      selection.finishRowSelection();
      pointerDocument.restore();
    }
  });

  it("recovers from a lost mouseup when mouse movement reports no primary button", () => {
    const pointerDocument = installPointerDocument();
    let pointerRow = 2;
    let pointerCell = { rowIndex: 2, colIndex: 2 };
    const selection = createSelection({
      cellFromClientPoint: () => pointerCell,
      rowFromClientPoint: () => pointerRow,
      shouldUpdateDraggedRowsImmediately: () => true,
    });

    try {
      selection.beginRowSelection(1, 2, { button: 0, clientX: 5, clientY: 10, preventDefault() {} } as MouseEvent);
      pointerDocument.dispatch("mousemove", { buttons: 1, clientX: 5, clientY: 40 } as MouseEvent);
      expect(selection.selectedRowIds.value).toEqual(new Set([2, 3]));

      pointerRow = 3;
      pointerDocument.dispatch("mousemove", { buttons: 0, clientX: 5, clientY: 70 } as MouseEvent);
      expect(selection.isSelectingRows.value).toBe(false);
      expect(selection.selectedRowIds.value).toEqual(new Set([2, 3]));

      pointerRow = 0;
      pointerDocument.dispatch("mousemove", { buttons: 1, clientX: 5, clientY: 90 } as MouseEvent);
      expect(selection.selectedRowIds.value).toEqual(new Set([2, 3]));

      selection.clearRowSelection();
      selection.beginCellSelection(0, 0, { button: 0, clientX: 10, clientY: 10, preventDefault() {} } as MouseEvent);
      pointerDocument.dispatch("mousemove", { buttons: 1, clientX: 30, clientY: 30 } as MouseEvent);
      expect(selection.selectedRange.value).toEqual({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 });

      pointerCell = { rowIndex: 3, colIndex: 2 };
      pointerDocument.dispatch("mousemove", { buttons: 0, clientX: 40, clientY: 40 } as MouseEvent);
      expect(selection.isSelectingCells.value).toBe(false);
      expect(selection.selectedRange.value).toEqual({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 });
    } finally {
      selection.finishCellSelection();
      selection.finishRowSelection();
      pointerDocument.restore();
    }
  });

  it("updates row drags synchronously and invalidates the final mouseup selection", () => {
    const pointerDocument = installPointerDocument();
    const onDraggedRowSelectionChange = vi.fn();
    let pointerRow = 1;
    const selection = createSelection({
      rowFromClientPoint: () => pointerRow,
      shouldUpdateDraggedRowsImmediately: () => true,
      onDraggedRowSelectionChange,
    });

    try {
      selection.beginRowSelection(1, 2, { button: 0, clientX: 5, clientY: 10, preventDefault() {} } as MouseEvent);
      onDraggedRowSelectionChange.mockClear();

      pointerRow = 2;
      pointerDocument.dispatch("mousemove", { clientX: 5, clientY: 40 } as MouseEvent);
      expect(selection.selectedRowIds.value).toEqual(new Set([2, 3]));
      expect(onDraggedRowSelectionChange).toHaveBeenCalledTimes(1);

      pointerRow = 3;
      pointerDocument.dispatch("mouseup", { clientX: 5, clientY: 66 } as MouseEvent);
      expect(selection.selectedRowIds.value).toEqual(new Set([2, 3, 4]));
      expect(onDraggedRowSelectionChange).toHaveBeenCalledTimes(2);

      pointerRow = 0;
      pointerDocument.dispatch("mousemove", { clientX: 5, clientY: 92 } as MouseEvent);
      expect(selection.selectedRowIds.value).toEqual(new Set([2, 3, 4]));
      expect(onDraggedRowSelectionChange).toHaveBeenCalledTimes(2);
    } finally {
      selection.finishRowSelection();
      pointerDocument.restore();
    }
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

  it("keeps a restored range stable until a new pointer gesture begins", () => {
    const originalDocument = globalThis.document;
    const fakeDocument = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
    const selection = createSelection();

    try {
      selection.restoreCellSelectionState({
        anchor: { rowIndex: 0, colIndex: 0 },
        focus: { rowIndex: 1, colIndex: 1 },
      });

      selection.extendCellSelection(3, 2);
      expect(selection.isSelectingCells.value).toBe(false);
      expect(selection.selectedRange.value).toEqual({ startRow: 0, endRow: 1, startCol: 0, endCol: 1 });

      selection.beginCellSelection(1, 1, { button: 0, clientX: 0, clientY: 0, preventDefault() {} } as MouseEvent);
      selection.extendCellSelection(3, 2);
      expect(selection.selectedRange.value).toEqual({ startRow: 1, endRow: 3, startCol: 1, endCol: 2 });
    } finally {
      selection.finishCellSelection();
      Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
    }
  });
});
