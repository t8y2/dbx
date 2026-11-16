import { describe, expect, it } from "vitest";
import { nextBookmarkLine, normalizeBookmarkLines, toggleBookmarkLine } from "../bookmarkNavigation";

describe("bookmarkNavigation", () => {
  it("normalizes line starts by dropping duplicates and sorting them", () => {
    expect(normalizeBookmarkLines([30, 10, 30, -1, 20])).toEqual([10, 20, 30]);
  });

  it("toggles a line start on and off", () => {
    expect(toggleBookmarkLine([20], 10)).toEqual([10, 20]);
    expect(toggleBookmarkLine([10, 20], 20)).toEqual([10]);
  });

  it("moves to the next bookmark and wraps after the last one", () => {
    const bookmarks = [10, 20, 30];

    expect(nextBookmarkLine(bookmarks, 0, "next")).toBe(10);
    expect(nextBookmarkLine(bookmarks, 10, "next")).toBe(20);
    expect(nextBookmarkLine(bookmarks, 20, "next")).toBe(30);
    expect(nextBookmarkLine(bookmarks, 30, "next")).toBe(10);
  });

  it("moves to the previous bookmark and wraps before the first one", () => {
    const bookmarks = [10, 20, 30];

    expect(nextBookmarkLine(bookmarks, 40, "previous")).toBe(30);
    expect(nextBookmarkLine(bookmarks, 30, "previous")).toBe(20);
    expect(nextBookmarkLine(bookmarks, 20, "previous")).toBe(10);
    expect(nextBookmarkLine(bookmarks, 10, "previous")).toBe(30);
  });

  it("returns no target when the editor has no bookmarks", () => {
    expect(nextBookmarkLine([], 0, "next")).toBeNull();
    expect(nextBookmarkLine([], 0, "previous")).toBeNull();
  });
});
