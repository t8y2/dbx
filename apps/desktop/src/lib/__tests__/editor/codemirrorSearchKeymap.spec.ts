// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { searchKeymap } from "@codemirror/search";
import { describe, expect, it } from "vitest";
import { searchKeymapWithoutModD } from "@/lib/editor/codemirrorSearchKeymap";

describe("searchKeymapWithoutModD", () => {
  it("drops the built-in Mod-d binding from the search keymap", () => {
    const filtered = searchKeymapWithoutModD(searchKeymap);
    expect(filtered.find((binding) => binding.key === "Mod-d")).toBeUndefined();
  });

  it("keeps the other search bindings intact", () => {
    const filtered = searchKeymapWithoutModD(searchKeymap);
    const keys = filtered.map((binding) => binding.key);
    expect(keys).toContain("Mod-f");
    expect(keys).toContain("Mod-g");
    expect(keys).toContain("Mod-Alt-g");
    expect(keys).toContain("Mod-Shift-l");
    expect(keys).toContain("F3");
  });

  it("baseline: the stock searchKeymap consumes Ctrl+D (the bug being fixed)", () => {
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        extensions: [keymap.of([...searchKeymap])],
      }),
    });

    expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "d", ctrlKey: true }), "editor")).toBe(true);
    view.destroy();
  });

  it("no longer consumes Ctrl+D, letting the event bubble to the global shortcut handler", () => {
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        extensions: [keymap.of([...searchKeymapWithoutModD(searchKeymap)])],
      }),
    });

    expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "d", ctrlKey: true }), "editor")).toBe(false);
    view.destroy();
  });
});
