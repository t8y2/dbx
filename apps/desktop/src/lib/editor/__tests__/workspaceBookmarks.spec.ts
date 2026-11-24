import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { bookmarkDocumentChange, mapPersistedBookmarks } from "../workspaceBookmarks";
import { workspaceBookmarkCases } from "./workspaceBookmarkCases";

describe("workspace bookmark document mapping", () => {
  it.each(workspaceBookmarkCases)("maps $name", ({ before, after, saved, expected }) => {
    expect(mapPersistedBookmarks(before, after, saved)).toEqual(expected);
    const doc = Text.of(before.split("\n"));
    expect(ChangeSet.of(bookmarkDocumentChange(before, after), doc.length).apply(doc).toString()).toBe(after);
  });

  it("handles separated CRLF insertions and an absent final newline", () => {
    expect(mapPersistedBookmarks("a\r\nb\r\nc", "new\r\na\r\nb\r\nmid\r\nc", [1, 3])).toEqual([2, 5]);
  });

  it("keeps a bookmark on a line with an in-line edit", () => {
    expect(mapPersistedBookmarks("select a;\nselect b;", "select aa;\nselect bb;", [1, 2])).toEqual([1, 2]);
  });

  it("bounds diff work for unrelated large documents and uses replacement boundaries", () => {
    const before = Array.from({ length: 1200 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 1200 }, (_, i) => `new ${i}`).join("\n");
    expect(mapPersistedBookmarks(before, after, [1, 600, 1200])).toEqual([1, 1200]);
    expect(
      ChangeSet.of(bookmarkDocumentChange(before, after), before.length)
        .apply(Text.of(before.split("\n")))
        .toString(),
    ).toBe(after);
  });
});
