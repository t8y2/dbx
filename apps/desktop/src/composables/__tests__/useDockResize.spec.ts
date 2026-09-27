// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { useDockResize } from "@/composables/useDockResize";

function pointerEvent(type: string, clientY: number, options: { pointerId?: number; button?: number; buttons?: number } = {}): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, clientY, button: options.button ?? 0 });
  Object.defineProperty(event, "pointerId", { value: options.pointerId ?? 1 });
  Object.defineProperty(event, "buttons", { value: options.buttons ?? (type === "pointermove" ? 1 : 0) });
  return event;
}

function stubWindowHeight(height: number) {
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(height);
}

describe("useDockResize", () => {
  beforeEach(() => {
    stubWindowHeight(1000);
    document.body.replaceChildren();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  function setup(rootHeight = 320) {
    const dockHeight = ref(rootHeight);
    const root = document.createElement("div");
    document.body.append(root);
    const handle = document.createElement("div");
    root.append(handle);
    const { startResize } = useDockResize({
      dockHeight,
      minHeight: 140,
      dockElement: () => root,
    });
    handle.addEventListener("pointerdown", startResize);
    return { dockHeight, root, handle };
  }

  it("grows when dragging the top edge upward and commits the height on pointerup", () => {
    const { dockHeight, root, handle } = setup(320);
    handle.dispatchEvent(pointerEvent("pointerdown", 680));
    document.dispatchEvent(pointerEvent("pointermove", 580));
    expect(root.style.height).toBe("420px");
    document.dispatchEvent(pointerEvent("pointerup", 580));
    expect(dockHeight.value).toBe(420);
  });

  it("shrinks when dragging downward and clamps at the minimum height", () => {
    const { dockHeight, root, handle } = setup(320);
    handle.dispatchEvent(pointerEvent("pointerdown", 680));
    document.dispatchEvent(pointerEvent("pointermove", 800));
    expect(root.style.height).toBe("200px");
    document.dispatchEvent(pointerEvent("pointermove", 2000));
    expect(root.style.height).toBe("140px");
    document.dispatchEvent(pointerEvent("pointerup", 2000));
    expect(dockHeight.value).toBe(140);
  });

  it("caps the height at the viewport fraction shared with the maximize button", () => {
    const { dockHeight, handle } = setup(320);
    handle.dispatchEvent(pointerEvent("pointerdown", 900));
    document.dispatchEvent(pointerEvent("pointermove", 0));
    document.dispatchEvent(pointerEvent("pointerup", 0));
    expect(dockHeight.value).toBe(800);
  });

  it("finishes the drag on pointercancel instead of leaking the listeners", () => {
    const { dockHeight, root, handle } = setup(320);
    handle.dispatchEvent(pointerEvent("pointerdown", 680));
    document.dispatchEvent(pointerEvent("pointermove", 500));
    expect(root.style.height).toBe("500px");
    document.dispatchEvent(pointerEvent("pointercancel", 500));
    expect(dockHeight.value).toBe(500);
    expect(document.body.querySelector('[aria-hidden="true"]')).toBeNull();
    // A later buttonless move must not ghost-drive the dock.
    document.dispatchEvent(pointerEvent("pointermove", 200));
    expect(dockHeight.value).toBe(500);
    expect(root.style.height).toBe("500px");
  });

  it("finishes the drag when the window loses focus", () => {
    const { dockHeight, handle } = setup(320);
    handle.dispatchEvent(pointerEvent("pointerdown", 680));
    window.dispatchEvent(new Event("blur"));
    expect(dockHeight.value).toBe(320);
    expect(document.body.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("ignores non-primary-button presses", () => {
    const { dockHeight, root, handle } = setup(320);
    handle.dispatchEvent(pointerEvent("pointerdown", 680, { button: 2, buttons: 2 }));
    document.dispatchEvent(pointerEvent("pointermove", 400, { buttons: 2 }));
    expect(root.style.height).toBe("");
    document.dispatchEvent(pointerEvent("pointerup", 400));
    expect(dockHeight.value).toBe(320);
  });

  it("starts from the rendered height so a drag out of the maximized state is seamless", () => {
    const { dockHeight, root, handle } = setup(320);
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({ height: 700, top: 300 } as DOMRect);
    handle.dispatchEvent(pointerEvent("pointerdown", 300));
    document.dispatchEvent(pointerEvent("pointermove", 200));
    document.dispatchEvent(pointerEvent("pointerup", 200));
    expect(dockHeight.value).toBe(800);
  });

  it("toggles the global resize freeze flag for heavy subtrees", () => {
    const { handle } = setup(320);
    handle.dispatchEvent(pointerEvent("pointerdown", 680));
    expect(document.body.classList.contains("dbx-is-resizing")).toBe(true);
    document.dispatchEvent(pointerEvent("pointerup", 600));
    expect(document.body.classList.contains("dbx-is-resizing")).toBe(false);
  });
});
