import { describe, expect, it } from "vitest";
import { dataGridBottomScrollTop, isDataGridAtScrollBottom, restoredDataGridScrollLeft } from "@/lib/dataGrid/dataGridInfiniteScroll";

describe("data grid bottom anchoring", () => {
  it("keeps DOM rows anchored when scrollbar padding increases the scroll height", () => {
    const before = { scrollTop: 740, scrollHeight: 1000, clientHeight: 260 };
    const after = { scrollHeight: 1010, clientHeight: 260 };

    expect(isDataGridAtScrollBottom(before)).toBe(true);
    expect(dataGridBottomScrollTop(after)).toBe(750);
  });

  it("keeps canvas rows anchored when scrollbar margin reduces the viewport", () => {
    const before = { scrollTop: 740, scrollHeight: 1000, clientHeight: 260 };
    const after = { scrollHeight: 1000, clientHeight: 250 };

    expect(isDataGridAtScrollBottom(before)).toBe(true);
    expect(dataGridBottomScrollTop(after)).toBe(750);
  });

  it("keeps the quick-entry draft row visible after the horizontal scrollbar appears", () => {
    const before = { scrollTop: 766, scrollHeight: 1026, clientHeight: 260 };
    const after = { scrollHeight: 1036, clientHeight: 260 };

    expect(isDataGridAtScrollBottom(before)).toBe(true);
    expect(dataGridBottomScrollTop(after)).toBe(776);
  });

  it("does not anchor a user who is away from the bottom", () => {
    expect(isDataGridAtScrollBottom({ scrollTop: 700, scrollHeight: 1000, clientHeight: 260 })).toBe(false);
  });
});

describe("data grid horizontal restoration", () => {
  it("restores the previous horizontal position after the grid remounts", () => {
    expect(restoredDataGridScrollLeft(320, 1200, 600)).toBe(320);
  });

  it("clamps the previous position when the scrollable width shrinks", () => {
    expect(restoredDataGridScrollLeft(720, 1000, 600)).toBe(400);
  });

  it("resets the position when the rebuilt grid no longer overflows", () => {
    expect(restoredDataGridScrollLeft(320, 500, 600)).toBe(0);
  });
});
