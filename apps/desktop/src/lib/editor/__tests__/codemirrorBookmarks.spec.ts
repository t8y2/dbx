// @vitest-environment happy-dom

import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { createQueryEditorBookmarks } from "../codemirrorBookmarks";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function createEditor(doc: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const bookmarks = createQueryEditorBookmarks({
    modules: { EditorView, StateField, StateEffect, GutterMarker, gutter },
    toggleLabel: () => "Toggle bookmark",
  });
  const view = new EditorView({
    parent: host,
    state: EditorState.create({ doc, extensions: [bookmarks.extension] }),
  });
  cleanups.push(() => {
    view.destroy();
    host.remove();
  });
  return { view, host, bookmarks };
}

function placeCursor(view: EditorView, lineNumber: number) {
  view.dispatch({ selection: { anchor: view.state.doc.line(lineNumber).from } });
}

function visibleBookmarkMarkerCount(host: HTMLElement): number {
  return [...host.querySelectorAll<HTMLElement>(".cm-bookmark-gutter .cm-gutterElement")].filter((element) => element.style.visibility !== "hidden" && element.querySelector(".cm-bookmark-marker")).length;
}

describe("createQueryEditorBookmarks", () => {
  it("renders and removes gutter markers when the current line is toggled", () => {
    const { view, host, bookmarks } = createEditor("one\ntwo\nthree\nfour");
    expect(visibleBookmarkMarkerCount(host)).toBe(0);

    placeCursor(view, 2);
    expect(bookmarks.toggle(view)).toBe(true);
    expect(visibleBookmarkMarkerCount(host)).toBe(1);

    expect(bookmarks.toggle(view)).toBe(true);
    expect(visibleBookmarkMarkerCount(host)).toBe(0);
  });

  it("navigates between bookmarks and wraps at both ends", () => {
    const { view, bookmarks } = createEditor("one\ntwo\nthree\nfour");
    const lineStart = (lineNumber: number) => view.state.doc.line(lineNumber).from;

    placeCursor(view, 2);
    bookmarks.toggle(view);
    placeCursor(view, 4);
    bookmarks.toggle(view);
    placeCursor(view, 1);

    expect(bookmarks.next(view)).toBe(true);
    expect(view.state.selection.main.head).toBe(lineStart(2));

    expect(bookmarks.next(view)).toBe(true);
    expect(view.state.selection.main.head).toBe(lineStart(4));

    expect(bookmarks.next(view)).toBe(true);
    expect(view.state.selection.main.head).toBe(lineStart(2));

    expect(bookmarks.previous(view)).toBe(true);
    expect(view.state.selection.main.head).toBe(lineStart(4));
  });

  it("keeps bookmarks attached to their lines when text is inserted above them", () => {
    const { view, bookmarks } = createEditor("one\ntwo\nthree\nfour");
    placeCursor(view, 3);
    bookmarks.toggle(view);

    view.dispatch({ changes: { from: 0, insert: "inserted\n" } });
    placeCursor(view, 1);

    expect(bookmarks.next(view)).toBe(true);
    expect(view.state.selection.main.head).toBe(view.state.doc.line(4).from);
  });

  it("clears every bookmark when the editor state is reset", () => {
    const { view, host, bookmarks } = createEditor("one\ntwo\nthree");
    placeCursor(view, 1);
    bookmarks.toggle(view);
    placeCursor(view, 2);
    bookmarks.toggle(view);
    expect(visibleBookmarkMarkerCount(host)).toBe(2);

    bookmarks.reset(view);

    expect(visibleBookmarkMarkerCount(host)).toBe(0);
    expect(bookmarks.next(view)).toBe(false);
  });

  it("leaves the cursor alone when there are no bookmarks", () => {
    const { view, bookmarks } = createEditor("one\ntwo");
    placeCursor(view, 2);
    const cursor = view.state.selection.main.head;

    expect(bookmarks.next(view)).toBe(false);
    expect(bookmarks.previous(view)).toBe(false);
    expect(view.state.selection.main.head).toBe(cursor);
  });
});
