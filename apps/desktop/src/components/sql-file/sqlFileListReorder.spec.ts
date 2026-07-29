import { describe, expect, it } from "vitest";
import type { SqlFilePreview } from "@/lib/backend/api";
import { canMoveDown, canMoveUp, moveFile, removeFile } from "./sqlFileListReorder";

function makePreview(fileName: string, filePath: string): SqlFilePreview {
  return {
    fileName,
    filePath,
    sizeBytes: 100,
    preview: "SELECT 1;",
    canExecuteWithoutSelectedDatabase: false,
  };
}

function sampleList(): SqlFilePreview[] {
  return [makePreview("a.sql", "/a.sql"), makePreview("b.sql", "/b.sql"), makePreview("c.sql", "/c.sql")];
}

describe("moveFile", () => {
  it("moves an item up by one position", () => {
    const result = moveFile(sampleList(), 1, -1);
    expect(result.map((item) => item.filePath)).toEqual(["/b.sql", "/a.sql", "/c.sql"]);
  });

  it("moves an item down by one position", () => {
    const result = moveFile(sampleList(), 0, 1);
    expect(result.map((item) => item.filePath)).toEqual(["/b.sql", "/a.sql", "/c.sql"]);
  });

  it("moves the first item to the end via repeated down moves", () => {
    let list = sampleList();
    list = moveFile(list, 0, 1);
    list = moveFile(list, 1, 1);
    expect(list.map((item) => item.filePath)).toEqual(["/b.sql", "/c.sql", "/a.sql"]);
  });

  it("is a no-op when moving the first item up", () => {
    const original = sampleList();
    const result = moveFile(original, 0, -1);
    expect(result).toBe(original);
    expect(result.map((item) => item.filePath)).toEqual(["/a.sql", "/b.sql", "/c.sql"]);
  });

  it("is a no-op when moving the last item down", () => {
    const original = sampleList();
    const result = moveFile(original, 2, 1);
    expect(result).toBe(original);
    expect(result.map((item) => item.filePath)).toEqual(["/a.sql", "/b.sql", "/c.sql"]);
  });

  it("is a no-op for an out-of-range negative index", () => {
    const original = sampleList();
    expect(moveFile(original, -1, 1)).toBe(original);
  });

  it("is a no-op for an out-of-range positive index", () => {
    const original = sampleList();
    expect(moveFile(original, 5, -1)).toBe(original);
  });

  it("returns the same reference for an empty list", () => {
    const empty: SqlFilePreview[] = [];
    expect(moveFile(empty, 0, 1)).toBe(empty);
  });

  it("does not mutate the input array", () => {
    const original = sampleList();
    const snapshot = original.map((item) => item.filePath);
    moveFile(original, 0, 1);
    expect(original.map((item) => item.filePath)).toEqual(snapshot);
  });

  it("preserves all items after a move", () => {
    const result = moveFile(sampleList(), 1, 1);
    expect(result).toHaveLength(3);
    expect(new Set(result.map((item) => item.filePath))).toEqual(new Set(["/a.sql", "/b.sql", "/c.sql"]));
  });
});

describe("removeFile", () => {
  it("removes the item at the given index", () => {
    const result = removeFile(sampleList(), 1);
    expect(result.map((item) => item.filePath)).toEqual(["/a.sql", "/c.sql"]);
  });

  it("removes the first item", () => {
    const result = removeFile(sampleList(), 0);
    expect(result.map((item) => item.filePath)).toEqual(["/b.sql", "/c.sql"]);
  });

  it("removes the last item", () => {
    const result = removeFile(sampleList(), 2);
    expect(result.map((item) => item.filePath)).toEqual(["/a.sql", "/b.sql"]);
  });

  it("is a no-op for an out-of-range index", () => {
    const original = sampleList();
    expect(removeFile(original, -1)).toBe(original);
    expect(removeFile(original, 10)).toBe(original);
  });

  it("returns the same reference for an empty list", () => {
    const empty: SqlFilePreview[] = [];
    expect(removeFile(empty, 0)).toBe(empty);
  });

  it("does not mutate the input array", () => {
    const original = sampleList();
    const snapshot = original.map((item) => item.filePath);
    removeFile(original, 1);
    expect(original.map((item) => item.filePath)).toEqual(snapshot);
  });
});

describe("canMoveUp", () => {
  it("returns false for the first item", () => {
    expect(canMoveUp(sampleList(), 0)).toBe(false);
  });

  it("returns true for any non-first item", () => {
    expect(canMoveUp(sampleList(), 1)).toBe(true);
    expect(canMoveUp(sampleList(), 2)).toBe(true);
  });

  it("returns false when the list has fewer than 2 items", () => {
    expect(canMoveUp([makePreview("a.sql", "/a.sql")], 0)).toBe(false);
    expect(canMoveUp([], 0)).toBe(false);
  });
});

describe("canMoveDown", () => {
  it("returns false for the last item", () => {
    expect(canMoveDown(sampleList(), 2)).toBe(false);
  });

  it("returns true for any non-last item", () => {
    expect(canMoveDown(sampleList(), 0)).toBe(true);
    expect(canMoveDown(sampleList(), 1)).toBe(true);
  });

  it("returns false when the list has fewer than 2 items", () => {
    expect(canMoveDown([makePreview("a.sql", "/a.sql")], 0)).toBe(false);
    expect(canMoveDown([], 0)).toBe(false);
  });
});
