/**
 * @vitest-environment happy-dom
 */
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  STRUCTURE_PEEK_PANEL_SELECTOR,
  clearRememberedFocusedQueryEditorView,
  focusedQueryEditorView,
  queryEditorInsertContext,
  registerQueryEditorInsertContext,
  rememberFocusedQueryEditorView,
  shouldPreserveEditorFocusOnPeekPointerDown,
  unregisterQueryEditorInsertContext,
} from "@/lib/editor/focusedQueryEditorView";

function mountEditor(): { root: HTMLElement; view: EditorView } {
  const root = document.createElement("div");
  root.setAttribute("data-query-editor-root", "");
  document.body.appendChild(root);
  const view = new EditorView({
    state: EditorState.create({ doc: "select 1" }),
    parent: root,
  });
  return { root, view };
}

describe("shouldPreserveEditorFocusOnPeekPointerDown", () => {
  it("preserves focus for table / chrome clicks", () => {
    const td = document.createElement("td");
    expect(shouldPreserveEditorFocusOnPeekPointerDown(td)).toBe(true);
  });

  it("allows native focus for editable controls", () => {
    const input = document.createElement("input");
    expect(shouldPreserveEditorFocusOnPeekPointerDown(input)).toBe(false);

    const button = document.createElement("button");
    expect(shouldPreserveEditorFocusOnPeekPointerDown(button)).toBe(false);
  });
});

describe("focusedQueryEditorView", () => {
  afterEach(() => {
    clearRememberedFocusedQueryEditorView();
    document.body.replaceChildren();
  });

  it("returns the focused query editor under activeElement", () => {
    const { root, view } = mountEditor();
    view.focus();
    expect(focusedQueryEditorView(view.contentDOM)).toBe(view);
    expect(focusedQueryEditorView(root)).toBe(view);
  });

  it("falls back to the last focused editor when activeElement is inside a peek panel", () => {
    const { view } = mountEditor();
    rememberFocusedQueryEditorView(view);

    const peek = document.createElement("div");
    peek.setAttribute("data-structure-peek-panel", "");
    const input = document.createElement("input");
    peek.appendChild(input);
    document.body.appendChild(peek);

    expect(input.closest(STRUCTURE_PEEK_PANEL_SELECTOR)).toBe(peek);
    expect(focusedQueryEditorView(input)).toBe(view);
  });

  it("returns null when focus is outside editors and peek panels", () => {
    const { view } = mountEditor();
    rememberFocusedQueryEditorView(view);

    const sidebar = document.createElement("button");
    document.body.appendChild(sidebar);
    expect(focusedQueryEditorView(sidebar)).toBeNull();
  });

  it("ignores a remembered editor that was disconnected", () => {
    const { root, view } = mountEditor();
    rememberFocusedQueryEditorView(view);
    root.remove();

    const peek = document.createElement("div");
    peek.setAttribute("data-structure-peek-panel", "");
    document.body.appendChild(peek);
    expect(focusedQueryEditorView(peek)).toBeNull();
  });
});

describe("queryEditorInsertContext", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("stores and clears per-view insert context", () => {
    const { view } = mountEditor();
    registerQueryEditorInsertContext(view, { connectionId: "c1", database: "db", databaseType: "postgres" });
    expect(queryEditorInsertContext(view)).toEqual({ connectionId: "c1", database: "db", databaseType: "postgres" });
    unregisterQueryEditorInsertContext(view);
    expect(queryEditorInsertContext(view)).toBeUndefined();
  });
});
