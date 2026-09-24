import { describe, expect, it } from "vitest";
import { orderedListRangeAnchorIndex, orderedListRangeIndices, orderedListSelectionIntent } from "@/lib/selection/orderedListSelection";

describe("orderedListSelectionIntent", () => {
  it("uses Shift for range selection even when another modifier is also reported", () => {
    expect(orderedListSelectionIntent({ shiftKey: true, metaKey: false, ctrlKey: false })).toBe("range");
    expect(orderedListSelectionIntent({ shiftKey: true, metaKey: true, ctrlKey: false })).toBe("range");
    expect(orderedListSelectionIntent({ shiftKey: true, metaKey: false, ctrlKey: true })).toBe("range");
  });

  it("uses Cmd or Ctrl for toggle selection", () => {
    expect(orderedListSelectionIntent({ shiftKey: false, metaKey: true, ctrlKey: false })).toBe("toggle");
    expect(orderedListSelectionIntent({ shiftKey: false, metaKey: false, ctrlKey: true })).toBe("toggle");
  });

  it("uses an unmodified click for single selection", () => {
    expect(orderedListSelectionIntent({ shiftKey: false, metaKey: false, ctrlKey: false })).toBe("single");
  });
});

describe("orderedListRangeAnchorIndex", () => {
  const items = [
    { type: "file", id: "first" },
    { type: "folder", id: "folder" },
    { type: "file", id: "last" },
  ];

  it("keeps the explicit selection anchor", () => {
    expect(orderedListRangeAnchorIndex(items, 2, { type: "file", id: "first" })).toBe(2);
  });

  it("uses the active item when no explicit anchor exists", () => {
    expect(orderedListRangeAnchorIndex(items, null, { type: "folder", id: "folder" })).toBe(1);
  });

  it("does not fall back to the first item without an anchor", () => {
    expect(orderedListRangeAnchorIndex(items, null, null)).toBeNull();
    expect(orderedListRangeAnchorIndex(items, null, { type: "file", id: "missing" })).toBeNull();
  });
});

describe("orderedListRangeIndices", () => {
  it("covers both directions inclusively", () => {
    expect(orderedListRangeIndices(5, 1, 3)).toEqual([1, 2, 3]);
    expect(orderedListRangeIndices(5, 3, 1)).toEqual([1, 2, 3]);
    expect(orderedListRangeIndices(5, 2, 2)).toEqual([2]);
  });

  it("clamps to the list bounds", () => {
    expect(orderedListRangeIndices(3, 0, 2)).toEqual([0, 1, 2]);
  });

  it("returns nothing for an empty list or an out-of-range position", () => {
    expect(orderedListRangeIndices(0, 0, 0)).toEqual([]);
    expect(orderedListRangeIndices(3, -1, 1)).toEqual([]);
    expect(orderedListRangeIndices(3, 1, 3)).toEqual([]);
  });
});
