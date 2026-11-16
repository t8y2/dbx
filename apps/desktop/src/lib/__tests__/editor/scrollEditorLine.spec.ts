// @vitest-environment happy-dom

import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { scrollEditorLine } from "@/lib/editor/scrollEditorLine";
import { normalizeShortcutSettings, shortcutToCodeMirrorKey } from "@/lib/editor/shortcutRegistry";

describe("editor viewport scrolling", () => {
  it("scrolls both directions without editing text or moving any cursor", () => {
    const selection = EditorSelection.create([EditorSelection.range(0, 6), EditorSelection.cursor(9)], 1);
    const view = new EditorView({ parent: document.createElement("div"), state: EditorState.create({ doc: "SELECT 1;\nSELECT 2;", selection, extensions: [EditorState.allowMultipleSelections.of(true)] }) });
    try {
      const initialState = view.state;
      view.scrollDOM.scrollTop = 100;
      expect(scrollEditorLine(view, "up")).toBe(true);
      expect(view.scrollDOM.scrollTop).toBe(100 - view.defaultLineHeight);
      expect(scrollEditorLine(view, "down")).toBe(true);
      expect(view.scrollDOM.scrollTop).toBe(100);
      expect(view.state).toBe(initialState);
      expect(view.state.selection.eq(selection)).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it("uses Ctrl+arrows on Windows/Linux and avoids macOS system/page-navigation keys", () => {
    for (const platform of ["Win32", "Linux x86_64"]) {
      expect(normalizeShortcutSettings(undefined, platform)).toMatchObject({ scrollLineUp: "Ctrl+ArrowUp", scrollLineDown: "Ctrl+ArrowDown" });
    }
    expect(normalizeShortcutSettings(undefined, "MacIntel")).toMatchObject({ scrollLineUp: "Ctrl+Alt+ArrowUp", scrollLineDown: "Ctrl+Alt+ArrowDown" });
    expect(normalizeShortcutSettings({ scrollLineUp: "", scrollLineDown: "Alt+J" }, "Win32")).toMatchObject({ scrollLineUp: "", scrollLineDown: "Alt+J" });
  });

  it("dispatches a customized keybinding without moving the selection", () => {
    const shortcuts = normalizeShortcutSettings({ scrollLineDown: "Ctrl+Alt+ArrowDown" }, "Win32");
    const view = new EditorView({ parent: document.createElement("div"), state: EditorState.create({ doc: "SELECT 1;", extensions: [keymap.of([{ key: shortcutToCodeMirrorKey(shortcuts.scrollLineDown), run: (currentView) => scrollEditorLine(currentView, "down") }])] }) });
    try {
      expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "ArrowDown", ctrlKey: true, altKey: true }), "editor")).toBe(true);
      expect(view.state.selection.main.head).toBe(0);
      expect(view.scrollDOM.scrollTop).toBe(view.defaultLineHeight);
    } finally {
      view.destroy();
    }
  });
});
