// @vitest-environment happy-dom

import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { createQueryEditorSearchKeymap } from "@/lib/editor/queryEditorSearchKeymap";

describe("QueryEditor search keymap precedence", () => {
  it("runs the custom search binding before lower-priority CodeMirror bindings", () => {
    const openSearch = vi.fn(() => true);
    const lowerPrioritySearch = vi.fn(() => true);
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        extensions: [keymap.of([{ key: "Mod-f", run: lowerPrioritySearch }]), Prec.highest(keymap.of(createQueryEditorSearchKeymap({ openSearch, openReplace: () => true, isReadOnly: () => false })))],
      }),
    });

    expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "f", ctrlKey: true }), "editor")).toBe(true);
    expect(openSearch).toHaveBeenCalledOnce();
    expect(lowerPrioritySearch).not.toHaveBeenCalled();
    view.destroy();
  });
});
