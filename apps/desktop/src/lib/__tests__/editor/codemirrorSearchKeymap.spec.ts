// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { searchKeymap } from "@codemirror/search";
import { describe, expect, it } from "vitest";
import { searchKeymapWithoutModD } from "@/lib/editor/codemirrorSearchKeymap";

// CodeMirror resolves `Mod` from the *host's* `navigator.platform` once at
// module load, so a synthetic key event cannot influence it. Spelling the
// modifier out in the binding keys (Meta/Ctrl) and in the dispatched event
// makes each case deterministic on every host. `Mod` is the only
// platform-dependent part of normalizeKeyName: `Meta-d` and `Ctrl-d` normalize
// identically everywhere. (Same idiom as codemirrorDefaultKeymap.spec.ts.)
const platforms = [
  { name: "macOS", modifier: "Meta", event: { metaKey: true } },
  { name: "Windows", modifier: "Ctrl", event: { ctrlKey: true } },
] as const;

const withModifier = (bindings: readonly { key: string }[], modifier: "Meta" | "Ctrl") => bindings.map((binding) => ({ ...binding, key: binding.key.replace("Mod", modifier) }));

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

  for (const { name, modifier, event } of platforms) {
    it(`${name}: baseline — the stock searchKeymap consumes Mod+D (the bug being fixed)`, () => {
      const view = new EditorView({
        parent: document.createElement("div"),
        state: EditorState.create({
          extensions: [keymap.of(withModifier(searchKeymap as { key: string }[], modifier))],
        }),
      });

      expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "d", ...event }), "editor")).toBe(true);
      view.destroy();
    });

    it(`${name}: no longer consumes Mod+D, letting the event bubble to the global shortcut handler`, () => {
      const view = new EditorView({
        parent: document.createElement("div"),
        state: EditorState.create({
          extensions: [keymap.of(withModifier(searchKeymapWithoutModD(searchKeymap) as { key: string }[], modifier))],
        }),
      });

      expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "d", ...event }), "editor")).toBe(false);
      view.destroy();
    });
  }
});
