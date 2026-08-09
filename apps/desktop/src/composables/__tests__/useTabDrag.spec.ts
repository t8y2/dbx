// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { TAB_DRAG_HORIZONTAL_THRESHOLD, useTabDrag } from "@/composables/useTabDrag";

function createDragHarness(onDrop = vi.fn(() => true)) {
  const drag = useTabDrag(onDrop);
  const source = document.createElement("div");
  source.innerHTML = '<span class="truncate">Source</span>';
  source.addEventListener("mousedown", (event) => drag.startDrag(event, "source"));
  document.body.appendChild(source);
  return { drag, source, onDrop };
}

function beginDrag(source: HTMLElement, x = 100, y = 20) {
  source.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: x, clientY: y }));
}

function movePointer(x: number, y = 20) {
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
}

function releasePointer() {
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

function enterDropTarget(drag: ReturnType<typeof useTabDrag>, tabId = "target", x = 10) {
  const target = document.createElement("div");
  target.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 28, width: 100, height: 28, toJSON: () => ({}) });
  target.addEventListener("mousemove", (event) => drag.updateTarget(event, tabId));
  document.body.appendChild(target);
  target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: 20 }));
}

afterEach(() => {
  releasePointer();
  document.body.innerHTML = "";
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

describe("useTabDrag", () => {
  it("ignores sub-threshold horizontal movement and vertical pointer jitter", () => {
    const { drag, source, onDrop } = createDragHarness();
    beginDrag(source);

    movePointer(100 + TAB_DRAG_HORIZONTAL_THRESHOLD - 1, 120);

    expect(drag.state.active).toBe(false);
    expect(drag.state.suppressClick).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("does not suppress the click when a drag gesture has no valid drop target", () => {
    const { drag, source, onDrop } = createDragHarness();
    beginDrag(source);
    movePointer(100 + TAB_DRAG_HORIZONTAL_THRESHOLD);
    expect(drag.state.active).toBe(true);

    releasePointer();

    expect(onDrop).not.toHaveBeenCalled();
    expect(drag.state.suppressClick).toBe(false);
  });

  it("does not suppress the click when the drop callback reports no reorder", () => {
    const onDrop = vi.fn(() => false);
    const { drag, source } = createDragHarness(onDrop);
    beginDrag(source);
    movePointer(100 + TAB_DRAG_HORIZONTAL_THRESHOLD);
    enterDropTarget(drag);

    releasePointer();

    expect(onDrop).toHaveBeenCalledWith("source", "target", "before");
    expect(drag.state.suppressClick).toBe(false);
  });

  it("suppresses the click only after a completed reorder", () => {
    const { drag, source, onDrop } = createDragHarness();
    beginDrag(source);
    movePointer(100 + TAB_DRAG_HORIZONTAL_THRESHOLD);
    enterDropTarget(drag, "target", 90);

    releasePointer();

    expect(onDrop).toHaveBeenCalledWith("source", "target", "after");
    expect(drag.state.suppressClick).toBe(true);

    beginDrag(source);
    expect(drag.state.suppressClick).toBe(false);
  });
});
