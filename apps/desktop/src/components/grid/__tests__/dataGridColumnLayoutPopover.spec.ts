// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { DataGridColumnLayoutOption } from "@/composables/useDataGridColumnLayout";
import type { DataGridColumnLayoutHandle } from "../dataGridColumnLayoutPopover";
import { DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT, DATA_GRID_COLUMN_LAYOUT_VIEWPORT_HEIGHT, dataGridColumnLayoutDropTarget, dataGridColumnLayoutVirtualWindow } from "../dataGridColumnLayoutPopover";

vi.mock("@/components/ui/popover", async () => {
  const { defineComponent, h, onMounted } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  const popover = defineComponent({
    props: { open: Boolean },
    emits: ["update:open"],
    setup(_props, { emit, slots }) {
      onMounted(() => emit("update:open", true));
      return () => h("div", { "data-test-popover-root": "" }, [h("button", { class: "test-close-popover", onClick: () => emit("update:open", false) }), slots.default?.()]);
    },
  });
  return { Popover: popover, PopoverContent: passthrough, PopoverTrigger: passthrough };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      inheritAttrs: false,
      setup(_props, { attrs, slots }) {
        return () => h("button", attrs, slots.default?.());
      },
    }),
  };
});

import DataGridColumnLayoutPopover from "../DataGridColumnLayoutPopover.vue";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

function columnLayoutOptions(itemCount: number): DataGridColumnLayoutOption[] {
  return Array.from({ length: itemCount }, (_, index) => ({
    key: `column-${index}`,
    column: `column_${index}`,
    name: `column_${index}`,
    index,
    visible: true,
    displayPosition: index,
  }));
}

function createGrid(itemCount: number) {
  const options = columnLayoutOptions(itemCount);
  const toggleColumnVisibility = vi.fn();
  const moveDisplayableColumn = vi.fn();
  const grid: DataGridColumnLayoutHandle = {
    visibleColumnCount: itemCount,
    displayableColumnCount: itemCount,
    hiddenColumnCount: 0,
    orderedColumnLayoutOptions: options,
    filteredColumnLayoutOptions: (search) => {
      const normalizedSearch = search.trim().toLowerCase();
      return normalizedSearch ? options.filter((option) => option.column.toLowerCase().includes(normalizedSearch)) : options;
    },
    toggleColumnVisibility,
    showAllColumns: vi.fn(),
    invertColumnVisibility: vi.fn(),
    hasCustomColumnOrder: false,
    moveDisplayableColumn,
    resetColumnOrder: vi.fn(),
  };
  return { grid, moveDisplayableColumn, toggleColumnVisibility };
}

async function mountPopover(itemCount = 4) {
  const gridState = createGrid(itemCount);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(DataGridColumnLayoutPopover, { grid: gridState.grid });
  app.use(i18n);
  app.mount(host);
  mountedApps.push({ app, host });
  await nextTick();
  await nextTick();
  return { ...gridState, host, app };
}

function configureList(host: HTMLElement, itemCount: number) {
  const list = host.querySelector<HTMLElement>("[data-column-layout-list]")!;
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 288 },
    scrollHeight: { configurable: true, value: itemCount * DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT },
  });
  list.getBoundingClientRect = () => ({
    left: 0,
    right: 288,
    top: 0,
    bottom: 288,
    width: 288,
    height: 288,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return list;
}

function dispatchPointer(target: EventTarget, type: string, options: { pointerId?: number; clientX?: number; clientY: number }) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: options.pointerId ?? 1,
      clientX: options.clientX ?? 20,
      clientY: options.clientY,
    }),
  );
}

beforeEach(() => {
  i18n.global.locale.value = "en";
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  document.body.innerHTML = "";
  document.body.style.userSelect = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("data grid column layout popover", () => {
  it("renders only the visible field window plus a bounded buffer", () => {
    const window = dataGridColumnLayoutVirtualWindow({
      itemCount: 500,
      scrollTop: 1400,
      viewportHeight: 280,
    });

    expect(window).toEqual({
      start: 44,
      end: 66,
      offsetTop: 44 * DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT,
      totalHeight: 500 * DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT,
    });
  });

  it("clamps the virtual field window at the list boundaries", () => {
    expect(dataGridColumnLayoutVirtualWindow({ itemCount: 4, scrollTop: 9999 })).toMatchObject({
      start: 0,
      end: 4,
      totalHeight: 4 * DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT,
    });
  });

  it("maps row halves to symmetric insertion positions", () => {
    expect(dataGridColumnLayoutDropTarget({ clientY: 2, listTop: 0, scrollTop: 0, itemCount: 4, fromDisplayPosition: 2 })).toEqual({
      insertionIndex: 0,
      toDisplayPosition: 0,
    });
    expect(dataGridColumnLayoutDropTarget({ clientY: 50, listTop: 0, scrollTop: 0, itemCount: 4, fromDisplayPosition: 0 })).toEqual({
      insertionIndex: 2,
      toDisplayPosition: 1,
    });
  });

  it("separates the drag handle from the visibility toggle", async () => {
    const { host, toggleColumnVisibility } = await mountPopover(3);
    const handles = host.querySelectorAll<HTMLButtonElement>("[data-column-drag-handle]");
    const visibilityToggles = host.querySelectorAll<HTMLButtonElement>("[data-column-visibility-toggle]");
    const rows = host.querySelectorAll<HTMLElement>("[data-column-layout-row]");

    expect(handles[0]?.className).toContain("cursor-move");
    expect(rows[0]?.className).not.toContain("cursor-grab");
    handles[1]?.click();
    expect(toggleColumnVisibility).not.toHaveBeenCalled();

    visibilityToggles[1]?.click();
    expect(toggleColumnVisibility).toHaveBeenCalledOnce();
    expect(toggleColumnVisibility).toHaveBeenCalledWith(1);
  });

  it("starts after five pixels, shows an insertion line, and commits once without toggling visibility", async () => {
    const { host, moveDisplayableColumn, toggleColumnVisibility } = await mountPopover(4);
    configureList(host, 4);
    const handle = host.querySelector<HTMLButtonElement>("[data-column-drag-handle]")!;

    dispatchPointer(handle, "pointerdown", { clientY: 14 });
    dispatchPointer(window, "pointermove", { clientY: 18 });
    await nextTick();
    expect(host.querySelector("[data-column-drop-indicator]")).toBeNull();
    expect(document.body.querySelector("[data-column-drag-preview]")).toBeNull();

    dispatchPointer(window, "pointermove", { clientY: 50 });
    await nextTick();
    const dragPreview = document.body.querySelector<HTMLElement>("[data-column-drag-preview]")!;
    const initialPreviewTransform = dragPreview.style.transform;
    expect(host.querySelector<HTMLElement>("[data-column-drop-indicator]")?.style.top).toBe(`${2 * DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT}px`);
    expect(dragPreview.textContent).toContain("column_0");
    expect(initialPreviewTransform).toBe("translate3d(0px, 36px, 0)");
    expect(host.querySelector<HTMLElement>('[data-display-position="1"]')?.style.transform).toBe(`translateY(-${DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT}px)`);
    expect(document.body.style.userSelect).toBe("none");

    dispatchPointer(window, "pointermove", { clientX: 36, clientY: 52 });
    await nextTick();
    expect(dragPreview.style.transform).not.toBe(initialPreviewTransform);
    expect(dragPreview.style.transform).toBe("translate3d(16px, 38px, 0)");

    dispatchPointer(window, "pointerup", { clientX: 36, clientY: 52 });
    dispatchPointer(window, "pointerup", { clientX: 36, clientY: 52 });
    await nextTick();
    expect(moveDisplayableColumn).toHaveBeenCalledOnce();
    expect(moveDisplayableColumn).toHaveBeenCalledWith(0, 1);
    expect(toggleColumnVisibility).not.toHaveBeenCalled();
    expect(document.body.querySelector("[data-column-drag-preview]")).toBeNull();
    expect(document.body.style.userSelect).toBe("");
  });

  it("cancels without committing and disables handles while searching", async () => {
    const { host, moveDisplayableColumn } = await mountPopover(4);
    configureList(host, 4);
    const handle = host.querySelector<HTMLButtonElement>("[data-column-drag-handle]")!;

    dispatchPointer(handle, "pointerdown", { clientY: 14 });
    dispatchPointer(window, "pointermove", { clientY: 50 });
    dispatchPointer(window, "pointercancel", { clientY: 50 });
    dispatchPointer(window, "pointerup", { clientY: 50 });
    expect(moveDisplayableColumn).not.toHaveBeenCalled();

    const search = host.querySelector<HTMLInputElement>("input")!;
    search.value = "column_1";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    const filteredHandle = host.querySelector<HTMLButtonElement>("[data-column-drag-handle]")!;
    expect(filteredHandle.disabled).toBe(true);
    dispatchPointer(filteredHandle, "pointerdown", { clientY: 14 });
    dispatchPointer(window, "pointermove", { clientY: 50 });
    dispatchPointer(window, "pointerup", { clientY: 50 });
    expect(moveDisplayableColumn).not.toHaveBeenCalled();
  });

  it("clears active drag state when the popover closes", async () => {
    const { host, moveDisplayableColumn } = await mountPopover(4);
    configureList(host, 4);
    const handle = host.querySelector<HTMLButtonElement>("[data-column-drag-handle]")!;

    dispatchPointer(handle, "pointerdown", { clientY: 14 });
    dispatchPointer(window, "pointermove", { clientY: 50 });
    await nextTick();
    expect(host.querySelector("[data-column-drop-indicator]")).not.toBeNull();

    host.querySelector<HTMLButtonElement>(".test-close-popover")?.click();
    await nextTick();
    expect(host.querySelector("[data-column-drop-indicator]")).toBeNull();
    expect(document.body.querySelector("[data-column-drag-preview]")).toBeNull();
    dispatchPointer(window, "pointerup", { clientY: 50 });
    expect(moveDisplayableColumn).not.toHaveBeenCalled();
  });

  it("cancels active dragging on Escape and window blur", async () => {
    const { host, moveDisplayableColumn } = await mountPopover(4);
    configureList(host, 4);
    const handle = host.querySelector<HTMLButtonElement>("[data-column-drag-handle]")!;

    dispatchPointer(handle, "pointerdown", { pointerId: 3, clientY: 14 });
    dispatchPointer(window, "pointermove", { pointerId: 3, clientY: 50 });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    dispatchPointer(window, "pointerup", { pointerId: 3, clientY: 50 });

    dispatchPointer(handle, "pointerdown", { pointerId: 4, clientY: 14 });
    dispatchPointer(window, "pointermove", { pointerId: 4, clientY: 50 });
    window.dispatchEvent(new Event("blur"));
    dispatchPointer(window, "pointerup", { pointerId: 4, clientY: 50 });

    expect(moveDisplayableColumn).not.toHaveBeenCalled();
    expect(host.querySelector("[data-column-drop-indicator]")).toBeNull();
    expect(document.body.querySelector("[data-column-drag-preview]")).toBeNull();
    expect(document.body.style.userSelect).toBe("");
  });

  it("auto-scrolls virtualized fields and commits beyond the initial viewport", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        const frameId = nextFrameId++;
        frames.set(frameId, callback);
        return frameId;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((frameId: number) => frames.delete(frameId)),
    );
    const { host, moveDisplayableColumn } = await mountPopover(120);
    const list = configureList(host, 120);
    const handle = host.querySelector<HTMLButtonElement>("[data-column-drag-handle]")!;

    dispatchPointer(handle, "pointerdown", { pointerId: 7, clientY: 14 });
    dispatchPointer(window, "pointermove", { pointerId: 7, clientY: 286 });
    for (let frameIndex = 0; frameIndex < 30; frameIndex += 1) {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(frameIndex));
    }
    await nextTick();

    expect(list.scrollTop).toBeGreaterThan(DATA_GRID_COLUMN_LAYOUT_VIEWPORT_HEIGHT);
    expect(host.querySelector('[data-display-position="0"]')).toBeNull();
    expect(document.body.querySelector("[data-column-drag-preview]")?.textContent).toContain("column_0");
    dispatchPointer(window, "pointerup", { pointerId: 7, clientY: 286 });
    expect(moveDisplayableColumn).toHaveBeenCalledOnce();
    expect(moveDisplayableColumn.mock.calls[0]?.[1]).toBeGreaterThan(10);
  });
});
