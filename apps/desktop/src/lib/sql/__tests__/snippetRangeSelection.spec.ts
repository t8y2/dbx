import { describe, expect, it } from "vitest";
import { applySnippetRangeSelection } from "@/lib/sql/snippetRangeSelection";

function rows(...ids: string[]) {
  return ids.map((id) => ({ id }));
}

describe("applySnippetRangeSelection", () => {
  it("checks every row between the anchor and the clicked row, endpoints included", () => {
    const next = applySnippetRangeSelection(new Set(["a"]), rows("a", "b", "c", "d"), "a", "d");
    expect([...next!].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("works when the clicked row is above the anchor", () => {
    const next = applySnippetRangeSelection(new Set(["d"]), rows("a", "b", "c", "d"), "d", "b");
    expect([...next!].sort()).toEqual(["b", "c", "d"]);
  });

  it("unchecks the range when the anchor itself is unchecked", () => {
    // b was unchecked by the plain click that set the anchor; c and d were still checked
    const next = applySnippetRangeSelection(new Set(["a", "c", "e"]), rows("a", "b", "c", "d", "e"), "b", "d");
    expect([...next!].sort()).toEqual(["a", "e"]);
  });

  it("propagates the clicked row's flipped state when passed explicitly", () => {
    // shift-click turned the clicked row checked: the range follows that state,
    // even though the anchor is currently unchecked
    const next = applySnippetRangeSelection(new Set(["a"]), rows("a", "b", "c", "d"), "b", "d", true);
    expect([...next!].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("propagates an explicit uncheck over a checked anchor", () => {
    const next = applySnippetRangeSelection(new Set(["a", "b", "c"]), rows("a", "b", "c", "d"), "a", "c", false);
    expect(next).toEqual(new Set());
  });

  it("leaves selections outside the range untouched", () => {
    const next = applySnippetRangeSelection(new Set(["z", "a"]), rows("a", "b", "c"), "a", "c");
    expect(next).toEqual(new Set(["a", "b", "c", "z"]));
  });

  it("never mutates the incoming selection", () => {
    const selected = new Set(["a"]);
    applySnippetRangeSelection(selected, rows("a", "b", "c"), "a", "c");
    expect([...selected]).toEqual(["a"]);
  });

  it("returns null without an anchor (nothing plain-clicked yet)", () => {
    expect(applySnippetRangeSelection(new Set(), rows("a", "b"), undefined, "b")).toBeNull();
  });

  it("returns null when the anchor is not among the visible rows (filtered out or deleted)", () => {
    expect(applySnippetRangeSelection(new Set(["a"]), rows("b", "c"), "a", "c")).toBeNull();
  });

  it("returns null when the clicked row is the anchor itself", () => {
    expect(applySnippetRangeSelection(new Set(["a"]), rows("a", "b"), "a", "a")).toBeNull();
  });

  it("returns null when the clicked row is not in the visible rows", () => {
    expect(applySnippetRangeSelection(new Set(["a"]), rows("a", "b"), "a", "x")).toBeNull();
  });
});
