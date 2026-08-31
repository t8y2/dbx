// @vitest-environment happy-dom

import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { createQueryEditorSelectionCaseShortcutBindings } from "@/lib/editor/queryEditorSelectionCaseShortcut";

function createView(shortcut: string, run: (view: EditorView) => boolean, platform: string): EditorView {
  return new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({
      doc: "select MixedCase",
      selection: EditorSelection.range(0, 16),
      extensions: [keymap.of(createQueryEditorSelectionCaseShortcutBindings(shortcut, run, platform))],
    }),
  });
}

describe("QueryEditor selection case shortcuts", () => {
  it.each([
    ["Shift+Alt+U", "U"],
    ["Shift+Alt+L", "L"],
  ])("matches macOS %s by physical key when Option transforms event.key", (shortcut, code) => {
    const run = vi.fn(() => true);
    const view = createView(shortcut, run, "MacIntel");
    const event = new KeyboardEvent("keydown", {
      key: code === "U" ? "¨" : "Ò",
      code: `Key${code}`,
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });

    expect(runScopeHandlers(view, event, "editor")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    view.destroy();
  });

  it("leaves the shortcut unhandled when the conversion command declines", () => {
    const run = vi.fn(() => false);
    const view = createView("Shift+Alt+U", run, "MacIntel");
    const event = new KeyboardEvent("keydown", {
      key: "¨",
      code: "KeyU",
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });

    expect(runScopeHandlers(view, event, "editor")).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(run).toHaveBeenCalledOnce();
    view.destroy();
  });

  it("keeps multi-stroke custom shortcuts on CodeMirror's sequence binding", () => {
    const run = vi.fn(() => true);
    expect(createQueryEditorSelectionCaseShortcutBindings("Mod+K Mod+U", run, "MacIntel")).toEqual([
      {
        key: "Mod-k Mod-u",
        preventDefault: true,
        run,
      },
    ]);
  });
});
