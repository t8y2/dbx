// @vitest-environment happy-dom

import type { ShortcutSettings } from "@/lib/editor/shortcutRegistry";
import { afterEach, describe, expect, it, vi } from "vitest";

const macNavigator = {
  maxTouchPoints: 0,
  platform: "MacIntel",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
  vendor: "Apple Computer, Inc.",
};

async function createHarness(overrides?: Partial<ShortcutSettings>) {
  vi.stubGlobal("navigator", macNavigator);
  vi.resetModules();
  const [{ EditorState, Prec }, { EditorView, keymap, runScopeHandlers }, { sql }, { foldAll, foldedRanges, foldKeymap, unfoldAll }, { normalizeShortcutSettings }, { createQueryEditorFoldShortcutBindings, foldKeymapWithoutAllBindings }] = await Promise.all([
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("@codemirror/lang-sql"),
    import("@codemirror/language"),
    import("@/lib/editor/shortcutRegistry"),
    import("@/lib/editor/queryEditorFoldKeymap"),
  ]);
  const shortcuts = normalizeShortcutSettings(overrides, "MacIntel");
  const root = document.createElement("div");
  document.body.append(root);
  const view = new EditorView({
    parent: root,
    state: EditorState.create({
      doc: "/* first\nbody\n*/\n\n/* second\nbody\n*/",
      extensions: [sql(), keymap.of(foldKeymapWithoutAllBindings(foldKeymap, foldAll, unfoldAll)), Prec.high(keymap.of(createQueryEditorFoldShortcutBindings(shortcuts, foldAll, unfoldAll)))],
    }),
  });
  const press = (key: string, options: KeyboardEventInit) => runScopeHandlers(view, new KeyboardEvent("keydown", { key, code: key === "[" ? "BracketLeft" : "BracketRight", ...options }), "editor");
  const foldedCount = () => {
    let count = 0;
    foldedRanges(view.state).between(0, view.state.doc.length, () => count++);
    return count;
  };
  return { foldedCount, press, root, shortcuts, view };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("QueryEditor fold keymap on macOS", () => {
  it("keeps fold-current separate from the configurable fold-all defaults", async () => {
    const { foldedCount, press, shortcuts, view } = await createHarness();

    expect(shortcuts).toMatchObject({ foldAll: "Ctrl+Alt+[", unfoldAll: "Ctrl+Alt+]" });
    expect(press("[", { metaKey: true, altKey: true })).toBe(true);
    expect(foldedCount()).toBe(1);
    expect(press("]", { metaKey: true, altKey: true })).toBe(true);
    expect(foldedCount()).toBe(0);
    expect(press("[", { ctrlKey: true, altKey: true })).toBe(true);
    expect(foldedCount()).toBe(2);
    expect(press("]", { ctrlKey: true, altKey: true })).toBe(true);
    expect(foldedCount()).toBe(0);
    view.destroy();
  });

  it("does not retain CodeMirror fold-all keys when the settings are cleared", async () => {
    const { foldedCount, press, view } = await createHarness({ foldAll: "", unfoldAll: "" });

    expect(press("[", { ctrlKey: true, altKey: true })).toBe(false);
    expect(press("]", { ctrlKey: true, altKey: true })).toBe(false);
    expect(foldedCount()).toBe(0);
    view.destroy();
  });

  it("uses rebound fold-all keys without retaining the previous defaults", async () => {
    const { foldedCount, press, view } = await createHarness({ foldAll: "Ctrl+Shift+[", unfoldAll: "Ctrl+Shift+]" });

    expect(press("[", { ctrlKey: true, altKey: true })).toBe(false);
    expect(press("[", { ctrlKey: true, shiftKey: true })).toBe(true);
    expect(foldedCount()).toBe(2);
    expect(press("]", { ctrlKey: true, altKey: true })).toBe(false);
    expect(press("]", { ctrlKey: true, shiftKey: true })).toBe(true);
    expect(foldedCount()).toBe(0);
    view.destroy();
  });
});
