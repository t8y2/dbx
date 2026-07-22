import { describe, expect, it, vi } from "vitest";
import { focusDataGridEditorWithoutScrolling, preserveDataGridScrollPosition } from "@/lib/dataGrid/dataGridEditorFocus";

describe("preserveDataGridScrollPosition", () => {
  it("restores the viewport after an editor is removed", () => {
    const scroller = { scrollLeft: 720, scrollTop: 180 };
    const restoreScroll = preserveDataGridScrollPosition(scroller);

    scroller.scrollLeft = 0;
    scroller.scrollTop = 0;
    restoreScroll();

    expect(scroller).toEqual({ scrollLeft: 720, scrollTop: 180 });
  });
});

describe("focusDataGridEditorWithoutScrolling", () => {
  it("prevents focus from moving the data grid viewport", () => {
    const scroller = { scrollLeft: 720, scrollTop: 180 };
    const input = {
      focus: vi.fn((options?: FocusOptions) => {
        expect(options).toEqual({ preventScroll: true });
        // Some WebViews still move a virtualized ancestor while mounting the editor.
        scroller.scrollLeft = 0;
        scroller.scrollTop = 0;
      }),
    };

    focusDataGridEditorWithoutScrolling(input, scroller);

    expect(input.focus).toHaveBeenCalledOnce();
    expect(scroller).toEqual({ scrollLeft: 720, scrollTop: 180 });
  });
});
