import { describe, expect, it } from "vitest";
import { orderedListRangeAnchorIndex, orderedListSelectionIntent } from "@/lib/selection/orderedListSelection";

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
