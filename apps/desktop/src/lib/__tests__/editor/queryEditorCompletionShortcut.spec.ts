// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { createQueryEditorCompletionShortcutBindings } from "@/lib/editor/queryEditorCompletionShortcut";

function createView(shortcut: string, run: (view: EditorView) => boolean, platform: string): EditorView {
  return new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({
      extensions: [keymap.of(createQueryEditorCompletionShortcutBindings(shortcut, run, platform))],
    }),
  });
}

describe("QueryEditor manual completion shortcut", () => {
  it("dispatches macOS Option+/ by the physical Slash key", () => {
    const run = vi.fn(() => true);
    const view = createView("Alt+/", run, "MacIntel");
    const event = new KeyboardEvent("keydown", {
      key: "÷",
      code: "Slash",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });

    expect(runScopeHandlers(view, event, "editor")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(view);
    view.destroy();
  });

  it("leaves macOS Option+/ unhandled during IME composition", () => {
    const run = vi.fn(() => true);
    const view = createView("Alt+/", run, "MacIntel");
    const event = new KeyboardEvent("keydown", {
      key: "/",
      code: "Slash",
      altKey: true,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });

    expect(runScopeHandlers(view, event, "editor")).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(run).not.toHaveBeenCalled();
    view.destroy();
  });

  it("does not force-handle a configured shortcut when completion does not start", () => {
    const run = vi.fn(() => false);
    const view = createView("Alt+K", run, "MacIntel");
    const event = new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });

    expect(runScopeHandlers(view, event, "editor")).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(run).toHaveBeenCalledOnce();
    view.destroy();
  });

  it("keeps an empty configured shortcut disabled", () => {
    expect(createQueryEditorCompletionShortcutBindings("", () => true, "MacIntel")).toEqual([]);
  });
});
