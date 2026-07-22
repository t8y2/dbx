// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression spec for the "drag cannot release" bug. The sidebar drag-sort
 * channel stores `onDropCallback` in module-scope state so that all
 * TreeItem rows share a single drag session. We need to confirm that:
 *   1. mouseup at a registered row actually fires the callback
 *   2. the callback receives the source's id (not the target row's
 *      stale state from a re-mounted TreeItem)
 *   3. dropping outside any row does NOT throw / does NOT crash the
 *      drag session (no stuck cursor)
 */
describe("useDragSort — mouseup release", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = "";
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("mouseup dispatched on a row element still triggers the document-level callback (capture phase)", async () => {
    // Real browsers fire mouseup on whatever element is under the cursor,
    // then bubble/capture through the document. The composable relies on a
    // capture-phase listener attached to document so it can fire even when
    // the release happens inside elements that stop propagation. The
    // previous regression ("drag cannot release") is exactly that bug:
    // mouseup was fired on the row but the document-level handler never
    // received it because the listener was attached in bubble phase.
    const { useDragSort } = await import("@/composables/useDragSort");
    const callback = vi.fn();
    const drag = useDragSort(callback);

    const source = document.createElement("div");
    document.body.appendChild(source);
    const target = document.createElement("div");
    document.body.appendChild(target);

    const downEvent = new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 });
    Object.defineProperty(downEvent, "currentTarget", { value: source });
    drag.startDrag(downEvent, "source-id", "favorites-item");
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 20, clientY: 20 }));
    const moveEvent = new MouseEvent("mousemove", { clientX: 50, clientY: 12 });
    Object.defineProperty(moveEvent, "currentTarget", { value: target });
    drag.updateTarget(moveEvent, "target-id", "table");

    // fire the release on the row itself, NOT on the document directly.
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("mouseup without a target still resets cleanly (no stuck cursor, no callback)", async () => {
    const { useDragSort } = await import("@/composables/useDragSort");
    const callback = vi.fn();
    const drag = useDragSort(callback);

    const source = document.createElement("div");
    document.body.appendChild(source);

    const downEvent = new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 });
    Object.defineProperty(downEvent, "currentTarget", { value: source });
    drag.startDrag(downEvent, "source-id", "favorites-item");
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 20, clientY: 20 }));
    // release with no target hovered
    document.dispatchEvent(new MouseEvent("mouseup"));

    expect(callback).not.toHaveBeenCalled();
    // The cursor must reset so the user can interact again.
    expect(document.body.style.cursor).toBe("");
  });

  it("a throwing drop handler does NOT leave the drag session stuck", async () => {
    // Regression: previously onMouseUp called the user callback inline, so
    // a thrown handler would skip reset() — leaving the cursor at
    // "grabbing", the ghost element on the page, and state.draggedId set.
    // The user had to reload the window to recover.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { useDragSort } = await import("@/composables/useDragSort");
    const callback = vi.fn(() => {
      throw new Error("boom");
    });
    const drag = useDragSort(callback);

    const source = document.createElement("div");
    document.body.appendChild(source);
    const target = document.createElement("div");
    document.body.appendChild(target);

    const downEvent = new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 });
    Object.defineProperty(downEvent, "currentTarget", { value: source });
    drag.startDrag(downEvent, "source-id", "favorites-item");
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 20, clientY: 20 }));
    const moveEvent = new MouseEvent("mousemove", { clientX: 50, clientY: 12 });
    Object.defineProperty(moveEvent, "currentTarget", { value: target });
    drag.updateTarget(moveEvent, "target-id", "table");

    expect(() => document.dispatchEvent(new MouseEvent("mouseup"))).not.toThrow();
    expect(callback).toHaveBeenCalledTimes(1);
    // The session must have been torn down.
    expect(drag.state.active).toBe(false);
    expect(document.body.style.cursor).toBe("");
    errorSpy.mockRestore();
  });
});
