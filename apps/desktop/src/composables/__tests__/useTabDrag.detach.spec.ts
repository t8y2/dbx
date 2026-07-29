// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { useTabDrag } from "@/composables/useTabDrag";

function mouse(type: string, x: number, y: number) {
  return new MouseEvent(type, {
    bubbles: true,
    button: 0,
    buttons: type === "mouseup" ? 0 : 1,
    clientX: x,
    clientY: y,
  });
}

function startTabDrag(tabId: string, drag: ReturnType<typeof useTabDrag>) {
  const tab = document.createElement("div");
  tab.innerHTML = '<span class="truncate">Query</span>';
  tab.addEventListener("mousedown", (event) => drag.startDrag(event, tabId));
  document.body.append(tab);
  tab.dispatchEvent(mouse("mousedown", 20, 10));
  document.dispatchEvent(mouse("mousemove", 30, 30));
}

afterEach(() => {
  document.dispatchEvent(mouse("mouseup", 0, 0));
  document.body.innerHTML = "";
});

describe("useTabDrag detached window gesture", () => {
  it("detaches a dragged tab when released outside the tab bar", () => {
    const onDrop = vi.fn();
    const onDetach = vi.fn();
    const drag = useTabDrag(onDrop, {
      onDetach,
      shouldDetach: (event) => event.clientY > 40,
    });
    startTabDrag("query-1", drag);

    document.dispatchEvent(mouse("mouseup", 30, 80));

    expect(onDetach).toHaveBeenCalledWith("query-1");
    expect(onDrop).not.toHaveBeenCalled();
    expect(drag.state.active).toBe(false);
  });

  it("does not detach when released in blank space inside the tab bar", () => {
    const onDetach = vi.fn();
    const drag = useTabDrag(vi.fn(), {
      onDetach,
      shouldDetach: (event) => event.clientY > 40,
    });
    startTabDrag("query-1", drag);

    document.dispatchEvent(mouse("mouseup", 120, 20));

    expect(onDetach).not.toHaveBeenCalled();
    expect(drag.state.active).toBe(false);
  });

  it("does not detach a click that never crossed the drag threshold", () => {
    const onDetach = vi.fn();
    const drag = useTabDrag(vi.fn(), {
      onDetach,
      shouldDetach: () => true,
    });
    const tab = document.createElement("div");
    tab.addEventListener("mousedown", (event) => drag.startDrag(event, "query-1"));
    document.body.append(tab);
    tab.dispatchEvent(mouse("mousedown", 20, 10));

    document.dispatchEvent(mouse("mouseup", 20, 10));

    expect(onDetach).not.toHaveBeenCalled();
    expect(drag.state.wasDragged).toBe(false);
  });
});
