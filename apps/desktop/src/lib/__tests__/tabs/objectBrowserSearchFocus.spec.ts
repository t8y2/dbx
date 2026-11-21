// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { OBJECT_BROWSER_SEARCH_FOCUS_EVENT, objectBrowserSearchFocusTabId, requestObjectBrowserSearchFocus } from "@/lib/tabs/objectBrowserSearchFocus";

describe("object browser search focus requests", () => {
  it("dispatches the target tab id", () => {
    const listener = vi.fn();
    window.addEventListener(OBJECT_BROWSER_SEARCH_FOCUS_EVENT, listener);

    requestObjectBrowserSearchFocus("objects-1");

    expect(listener).toHaveBeenCalledOnce();
    expect(objectBrowserSearchFocusTabId(listener.mock.calls[0][0])).toBe("objects-1");
    window.removeEventListener(OBJECT_BROWSER_SEARCH_FOCUS_EVENT, listener);
  });

  it("ignores unrelated or malformed events", () => {
    expect(objectBrowserSearchFocusTabId(new Event(OBJECT_BROWSER_SEARCH_FOCUS_EVENT))).toBeUndefined();
    expect(objectBrowserSearchFocusTabId(new CustomEvent(OBJECT_BROWSER_SEARCH_FOCUS_EVENT, { detail: {} }))).toBeUndefined();
  });
});
