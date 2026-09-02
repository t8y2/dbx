// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h } from "vue";
import { DEFAULT_PANE_WIDTH_PERCENT, clampPaneWidthPercent, loadPaneWidthPercent, usePaneResize } from "@/composables/usePaneResize";

describe("usePaneResize width helpers", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("clamps widths into the supported range", () => {
    expect(clampPaneWidthPercent(5)).toBe(20);
    expect(clampPaneWidthPercent(50)).toBe(50);
    expect(clampPaneWidthPercent(95)).toBe(80);
  });

  it("loads a persisted width and clamps it", () => {
    const data = new Map<string, string>([["dbx-split-pane-width", "55"]]);
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => data.get(key) ?? null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    expect(loadPaneWidthPercent("dbx-split-pane-width")).toBe(55);
    data.set("dbx-split-pane-width", "99");
    expect(loadPaneWidthPercent("dbx-split-pane-width")).toBe(80);
  });

  it("falls back to the default width for missing or invalid values", () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    expect(loadPaneWidthPercent("dbx-split-pane-width")).toBe(DEFAULT_PANE_WIDTH_PERCENT);
  });
});

function fakeContainer(width: number, height: number): HTMLElement {
  const element = document.createElement("div");
  element.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, width, height, right: width, bottom: height, toJSON: () => ({}) }) as DOMRect;
  return element;
}

function mountComposable(storageKey: string, axis: "x" | "y") {
  let handle: ReturnType<typeof usePaneResize> | undefined;
  const app = createApp(
    defineComponent({
      setup() {
        handle = usePaneResize(storageKey, axis);
        return () => h("div");
      },
    }),
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  app.mount(host);
  return { handle: handle!, unmount: () => app.unmount() };
}

describe("usePaneResize drag", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => data.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => data.set(key, value)),
      removeItem: vi.fn(),
    });
  });

  it("maps horizontal pointer movement to a width percentage", () => {
    const { handle, unmount } = mountComposable("dbx-split-pane-width", "x");
    handle.beginResize(fakeContainer(1000, 500));
    expect(handle.isResizing.value).toBe(true);

    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 400, clientY: 10 }));
    expect(handle.sizePercent.value).toBe(40);

    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 5000, clientY: 10 }));
    expect(handle.sizePercent.value).toBe(80);

    window.dispatchEvent(new PointerEvent("pointerup"));
    expect(handle.isResizing.value).toBe(false);
    unmount();
  });

  it("maps vertical pointer movement to a height percentage", () => {
    const { handle, unmount } = mountComposable("dbx-split-pane-height", "y");
    handle.beginResize(fakeContainer(1000, 500));
    expect(handle.isResizing.value).toBe(true);

    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 10, clientY: 250 }));
    expect(handle.sizePercent.value).toBe(50);

    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 10, clientY: 1 }));
    expect(handle.sizePercent.value).toBe(20);

    window.dispatchEvent(new PointerEvent("pointerup"));
    unmount();
  });
});
