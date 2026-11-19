import { describe, expect, it, vi } from "vitest";
import { preserveQueryEditorScrollPosition, shouldStabilizeUnfocusedQueryEditorPointerDown, stabilizeUnfocusedQueryEditorPointerDown } from "@/lib/editor/queryEditorUnfocusedPointer";

function createEvent(
  overrides: Partial<{
    altKey: boolean;
    button: number;
    ctrlKey: boolean;
    detail: number;
    metaKey: boolean;
    shiftKey: boolean;
  }> = {},
) {
  return {
    altKey: false,
    button: 0,
    ctrlKey: false,
    detail: 1,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

function createView(hasFocus = false) {
  const scrollDOM = { scrollLeft: 40, scrollTop: 320 };
  return {
    hasFocus,
    focus: vi.fn(() => {
      scrollDOM.scrollLeft = 0;
      scrollDOM.scrollTop = 0;
    }),
    posAtCoords: vi.fn(() => 42),
    dispatch: vi.fn(),
    scrollDOM,
  };
}

describe("shouldStabilizeUnfocusedQueryEditorPointerDown", () => {
  it("handles an unmodified left click on an unfocused editor", () => {
    expect(
      shouldStabilizeUnfocusedQueryEditorPointerDown(createEvent(), {
        hasFocus: false,
      }),
    ).toBe(true);
  });

  it("leaves focused clicks, Shift-extend, multi-click, non-primary buttons, and modifier clicks alone", () => {
    expect(
      shouldStabilizeUnfocusedQueryEditorPointerDown(createEvent(), {
        hasFocus: true,
      }),
    ).toBe(false);
    expect(shouldStabilizeUnfocusedQueryEditorPointerDown(createEvent({ shiftKey: true }), { hasFocus: false })).toBe(false);
    expect(shouldStabilizeUnfocusedQueryEditorPointerDown(createEvent({ detail: 2 }), { hasFocus: false })).toBe(false);
    expect(shouldStabilizeUnfocusedQueryEditorPointerDown(createEvent({ detail: 3 }), { hasFocus: false })).toBe(false);
    expect(shouldStabilizeUnfocusedQueryEditorPointerDown(createEvent({ button: 1 }), { hasFocus: false })).toBe(false);
    expect(shouldStabilizeUnfocusedQueryEditorPointerDown(createEvent({ metaKey: true }), { hasFocus: false })).toBe(false);
    expect(shouldStabilizeUnfocusedQueryEditorPointerDown(createEvent({ ctrlKey: true }), { hasFocus: false })).toBe(false);
    expect(shouldStabilizeUnfocusedQueryEditorPointerDown(createEvent({ altKey: true }), { hasFocus: false })).toBe(false);
    expect(shouldStabilizeUnfocusedQueryEditorPointerDown(createEvent(), null)).toBe(false);
  });
});

describe("preserveQueryEditorScrollPosition", () => {
  it("restores a scroller that jumped during focus", () => {
    const scroller = { scrollLeft: 40, scrollTop: 320 };
    const restoreScroll = preserveQueryEditorScrollPosition(scroller);
    scroller.scrollLeft = 0;
    scroller.scrollTop = 0;
    restoreScroll();
    expect(scroller).toEqual({ scrollLeft: 40, scrollTop: 320 });
  });
});

describe("stabilizeUnfocusedQueryEditorPointerDown", () => {
  it("focuses and restores the viewport while leaving the selection to codemirror", () => {
    const view = createView();
    const event = createEvent();
    const scheduled: Array<() => void> = [];

    expect(stabilizeUnfocusedQueryEditorPointerDown(view, event, (callback) => scheduled.push(callback))).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(view.focus).toHaveBeenCalledOnce();
    expect(view.posAtCoords).not.toHaveBeenCalled();
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(view.scrollDOM).toEqual({ scrollLeft: 40, scrollTop: 320 });

    view.scrollDOM.scrollLeft = 12;
    view.scrollDOM.scrollTop = 8;
    scheduled[0]?.();
    expect(view.scrollDOM).toEqual({ scrollLeft: 40, scrollTop: 320 });
  });

  it("does not intercept a focused editor click", () => {
    const view = createView(true);
    const event = createEvent();

    expect(stabilizeUnfocusedQueryEditorPointerDown(view, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(view.focus).not.toHaveBeenCalled();
    expect(view.posAtCoords).not.toHaveBeenCalled();
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("does not intercept modifier clicks or non-left buttons", () => {
    for (const overrides of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { button: 1 }, { button: 2 }]) {
      const view = createView();
      const event = createEvent(overrides);

      expect(stabilizeUnfocusedQueryEditorPointerDown(view, event)).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(view.focus).not.toHaveBeenCalled();
      expect(view.dispatch).not.toHaveBeenCalled();
    }
  });
});
