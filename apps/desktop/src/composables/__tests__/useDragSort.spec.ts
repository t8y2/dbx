// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { dragSortAutoScrollDelta, useDragSort } from "@/composables/useDragSort";

const scrollerRect = {
  left: 100,
  right: 300,
  top: 100,
  bottom: 400,
};

afterEach(() => {
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("drag sort edge auto-scroll", () => {
  it("calculates proportional scrolling near either vertical edge", () => {
    const base = {
      pointerX: 150,
      rect: scrollerRect,
      scrollTop: 200,
      clientHeight: 300,
      scrollHeight: 1000,
    };

    expect(dragSortAutoScrollDelta({ ...base, pointerY: 95 })).toBe(-20);
    expect(dragSortAutoScrollDelta({ ...base, pointerY: 110 })).toBeLessThan(-4);
    expect(dragSortAutoScrollDelta({ ...base, pointerY: 250 })).toBe(0);
    expect(dragSortAutoScrollDelta({ ...base, pointerY: 390 })).toBeGreaterThan(4);
    expect(dragSortAutoScrollDelta({ ...base, pointerY: 405 })).toBe(20);
  });

  it("does not scroll at a boundary or when the pointer moves away horizontally", () => {
    const base = {
      rect: scrollerRect,
      clientHeight: 300,
      scrollHeight: 1000,
    };

    expect(dragSortAutoScrollDelta({ ...base, pointerX: 150, pointerY: 95, scrollTop: 0 })).toBe(0);
    expect(dragSortAutoScrollDelta({ ...base, pointerX: 150, pointerY: 405, scrollTop: 700 })).toBe(0);
    expect(dragSortAutoScrollDelta({ ...base, pointerX: 20, pointerY: 95, scrollTop: 200 })).toBe(0);
  });

  it("scrolls an opted-in container, refreshes the drop target, and stops on mouseup", () => {
    let nextFrameId = 1;
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });

    const container = document.createElement("div");
    container.className = "connection-tree-scroller";
    container.scrollTop = 200;
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1000 },
    });
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ ...scrollerRect, width: 200, height: 300, x: 100, y: 100, toJSON: () => ({}) } as DOMRect);

    const source = document.createElement("button");
    const target = document.createElement("div");
    container.append(source, target);
    document.body.append(container);

    const onDrop = vi.fn();
    const { state, startDrag, updateTarget } = useDragSort(onDrop);
    source.addEventListener("mousedown", (event) => startDrag(event, "dragged", "__pinned-tree-node__", { autoScroll: true, scrollContainer: container }));
    target.addEventListener("mousemove", (event) => updateTarget(event, "target", "__pinned-tree-node__"));
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ left: 100, right: 300, top: 100, bottom: 128, width: 200, height: 28, x: 100, y: 100, toJSON: () => ({}) } as DOMRect);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);

    source.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 150, clientY: 150 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 150, clientY: 95 }));

    expect(state.active).toBe(true);
    expect(frames.size).toBe(1);

    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 150, clientY: 90 }));
    expect(frames.size).toBe(1);

    const [frameId, frame] = [...frames.entries()][0];
    frames.delete(frameId);
    frame(16);

    expect(container.scrollTop).toBe(180);
    expect((document.body.lastElementChild as HTMLElement).style.top).toBe("78px");
    expect(state.targetId).toBe("target");
    expect(state.dropPosition).toBe("before");
    expect(frames.size).toBe(1);

    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(onDrop).toHaveBeenCalledWith("dragged", "target", "before");
    expect(state.active).toBe(false);
    expect(frames.size).toBe(0);
    expect(cancelFrame).toHaveBeenCalled();
  });

  it("drops no stale target after auto-scroll reaches an invalid row", () => {
    let nextFrameId = 1;
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });

    const container = document.createElement("div");
    container.className = "connection-tree-scroller";
    container.scrollTop = 200;
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1000 },
    });
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ ...scrollerRect, width: 200, height: 300, x: 100, y: 100, toJSON: () => ({}) } as DOMRect);

    const source = document.createElement("button");
    const validTarget = document.createElement("div");
    const invalidTarget = document.createElement("div");
    container.append(source, validTarget, invalidTarget);
    document.body.append(container);

    const onDrop = vi.fn();
    const { state, startDrag, updateTarget } = useDragSort(onDrop);
    source.addEventListener("mousedown", (event) => startDrag(event, "dragged", "__pinned-tree-node__", { autoScroll: true, scrollContainer: container }));
    validTarget.addEventListener("mousemove", (event) => updateTarget(event, "valid", "__pinned-tree-node__"));
    vi.spyOn(validTarget, "getBoundingClientRect").mockReturnValue({ left: 100, right: 300, top: 100, bottom: 128, width: 200, height: 28, x: 100, y: 100, toJSON: () => ({}) } as DOMRect);
    vi.spyOn(document, "elementFromPoint").mockReturnValueOnce(validTarget).mockReturnValue(invalidTarget);

    source.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 150, clientY: 150 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 150, clientY: 95 }));

    const firstFrameEntry = [...frames.entries()][0];
    frames.delete(firstFrameEntry[0]);
    firstFrameEntry[1](16);
    expect(state.targetId).toBe("valid");

    const secondFrameEntry = [...frames.entries()][0];
    frames.delete(secondFrameEntry[0]);
    secondFrameEntry[1](32);
    expect(state.targetId).toBeNull();
    expect(state.dropPosition).toBeNull();

    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("leaves ordinary drag sorting unchanged unless auto-scroll is requested", () => {
    const requestFrame = vi.spyOn(window, "requestAnimationFrame");
    const source = document.createElement("button");
    document.body.append(source);

    const { state, startDrag } = useDragSort(vi.fn());
    source.addEventListener("mousedown", (event) => startDrag(event, "dragged", "connection"));
    source.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 150, clientY: 150 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 150, clientY: 95 }));

    expect(state.active).toBe(true);
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it("ends a prepared drag even when mouseup happens before activation", () => {
    const source = document.createElement("button");
    document.body.append(source);
    const onEnd = vi.fn();

    const { startDrag } = useDragSort(vi.fn());
    source.addEventListener("mousedown", (event) => startDrag(event, "dragged", "__pinned-tree-node__", { onEnd }));
    source.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 150, clientY: 150 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(onEnd).toHaveBeenCalledOnce();
  });
});
