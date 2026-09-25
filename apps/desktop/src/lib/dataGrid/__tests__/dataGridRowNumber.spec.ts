import { describe, expect, it } from "vitest";
import { resolveDataGridRowNumberLabel } from "@/lib/dataGrid/dataGridRowNumber";

describe("data grid row number labels", () => {
  it("keeps the current view position by default", () => {
    expect(resolveDataGridRowNumberLabel({ displayIndex: 0, sourceRowNumbers: false, pageOffset: 0 })).toBe("1");
    expect(resolveDataGridRowNumberLabel({ displayIndex: 41, sourceIndex: 137, sourceRowNumbers: false, pageOffset: 0 })).toBe("42");
  });

  it("adds the page offset in paged results", () => {
    expect(resolveDataGridRowNumberLabel({ displayIndex: 0, sourceRowNumbers: false, pageOffset: 100 })).toBe("101");
    expect(resolveDataGridRowNumberLabel({ displayIndex: 0, sourceIndex: 0, sourceRowNumbers: true, pageOffset: 100 })).toBe("101");
  });

  it("survives filtering by reporting the original row number", () => {
    // 第 137 行被筛成视图里的第 3 行：原始行号模式下仍应显示 137
    expect(resolveDataGridRowNumberLabel({ displayIndex: 2, sourceIndex: 136, sourceRowNumbers: true, pageOffset: 0 })).toBe("137");
    // 分页场景下 sourceIndex 是页内下标，需要叠加页偏移
    expect(resolveDataGridRowNumberLabel({ displayIndex: 2, sourceIndex: 36, sourceRowNumbers: true, pageOffset: 100 })).toBe("137");
  });

  it("falls back to the view position for rows without a source index", () => {
    // 新增行还没有落库位置，sourceIndex 为 undefined
    expect(resolveDataGridRowNumberLabel({ displayIndex: 7, sourceRowNumbers: true, pageOffset: 0 })).toBe("8");
  });

  it("keeps the draft placeholder regardless of the mode", () => {
    expect(resolveDataGridRowNumberLabel({ displayIndex: 7, isDraft: true, sourceRowNumbers: false, pageOffset: 0 })).toBe("*");
    expect(resolveDataGridRowNumberLabel({ displayIndex: 7, sourceIndex: 3, isDraft: true, sourceRowNumbers: true, pageOffset: 100 })).toBe("*");
  });
});
