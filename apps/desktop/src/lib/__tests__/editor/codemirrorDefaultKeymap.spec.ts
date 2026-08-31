// @vitest-environment happy-dom

import { defaultKeymap } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers, type KeyBinding } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { defaultKeymapForGlobalShortcuts } from "@/lib/editor/codemirrorDefaultKeymap";
import { matchesShortcut } from "@/lib/editor/keyboardShortcuts";

const platforms = [
  { name: "macOS", platform: "MacIntel", modifier: "Meta", event: { metaKey: true } },
  { name: "Windows", platform: "Win32", modifier: "Ctrl", event: { ctrlKey: true } },
  { name: "Linux", platform: "Linux x86_64", modifier: "Ctrl", event: { ctrlKey: true } },
] as const;

function platformIndentBindings(bindings: readonly KeyBinding[], modifier: "Meta" | "Ctrl"): KeyBinding[] {
  return bindings.filter((binding) => binding.key === "Mod-[" || binding.key === "Mod-]").map((binding) => ({ ...binding, key: binding.key?.replace("Mod", modifier) }));
}

function createView(doc: string, bindings: readonly KeyBinding[], selection?: EditorSelection): EditorView {
  return new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({
      doc,
      selection,
      extensions: [keymap.of(bindings)],
    }),
  });
}

describe("defaultKeymapForGlobalShortcuts", () => {
  it("removes only the bracket binding occupied by a global shortcut", () => {
    const filtered = defaultKeymapForGlobalShortcuts(defaultKeymap, { toggleSidebar: "Mod+[" });
    expect(filtered.find((binding) => binding.key === "Mod-[")).toBeUndefined();
    expect(filtered.find((binding) => binding.key === "Mod-]")).toBeDefined();
    expect(filtered.find((binding) => binding.key === "Mod-a")).toBeDefined();
  });

  for (const { name, platform, modifier, event } of platforms) {
    for (const key of ["[", "]"] as const) {
      it(`${name} lets a conflicting global Mod+${key} action run while the editor is focused`, () => {
        const shortcut = `Mod+${key}`;
        const bindings = platformIndentBindings(defaultKeymapForGlobalShortcuts(defaultKeymap, { toggleSidebar: shortcut }), modifier);
        const view = createView("  select 1", bindings, EditorSelection.cursor(2));
        const keyboardEvent = new KeyboardEvent("keydown", { key, ...event });
        let globalActionRuns = 0;

        if (!runScopeHandlers(view, keyboardEvent, "editor") && matchesShortcut(keyboardEvent, shortcut, platform)) globalActionRuns++;

        expect(globalActionRuns).toBe(1);
        expect(view.state.doc.toString()).toBe("  select 1");
        view.destroy();
      });
    }

    it(`${name} preserves single-line Mod+[ outdent without a global conflict`, () => {
      const bindings = platformIndentBindings(defaultKeymapForGlobalShortcuts(defaultKeymap, { toggleSidebar: "Mod+B" }), modifier);
      const view = createView("  select 1", bindings, EditorSelection.cursor(2));

      expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "[", ...event }), "editor")).toBe(true);
      expect(view.state.doc.toString()).toBe("select 1");
      view.destroy();
    });

    it(`${name} preserves multi-line Mod+] indent without a global conflict`, () => {
      const doc = "select 1\nselect 2";
      const bindings = platformIndentBindings(defaultKeymapForGlobalShortcuts(defaultKeymap, { toggleSidebar: "Mod+B" }), modifier);
      const view = createView(doc, bindings, EditorSelection.range(0, doc.length));

      expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "]", ...event }), "editor")).toBe(true);
      expect(view.state.doc.toString()).toBe("  select 1\n  select 2");
      view.destroy();
    });
  }
});
