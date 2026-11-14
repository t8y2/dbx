// @vitest-environment happy-dom

// pi-lens-ignore: typescript:2307
import { EditorState, Prec } from "@codemirror/state";
// pi-lens-ignore: typescript:2307
import { EditorView, keymap, runScopeHandlers, type KeyBinding } from "@codemirror/view";
// pi-lens-ignore: typescript:2307
import { describe, expect, it, vi } from "vitest";
// pi-lens-ignore: typescript:2307
import { createQueryEditorExecutionShortcutBindings } from "@/lib/editor/queryEditorExecutionShortcut";
// pi-lens-ignore: typescript:2307
import { createQueryEditorReplaceShortcutBindings, createQueryEditorReplaceShortcutHandler, createQueryEditorSearchKeymap } from "@/lib/editor/queryEditorSearchKeymap";
// pi-lens-ignore: typescript:2307
import { searchKeymapWithoutConfigurableBindings } from "@/lib/editor/codemirrorSearchKeymap";
// pi-lens-ignore: typescript:2307
import { searchKeymap, searchPanelOpen } from "@codemirror/search";

// CodeMirror resolves `Mod` from the *host's* `navigator.platform` once at
// module load, so a synthetic key event cannot influence it. Spelling the
// modifier out in the binding keys (Meta/Ctrl) and in the dispatched event
// makes each case deterministic on every host. `Mod` is the only
// platform-dependent part of normalizeKeyName: `Meta-r` and `Ctrl-r` normalize
// identically everywhere. (Same idiom as codemirrorDefaultKeymap.spec.ts.)
const platforms = [
  { name: "macOS", platform: "MacIntel", modifier: "Meta", event: { metaKey: true } },
  { name: "Windows", platform: "Win32", modifier: "Ctrl", event: { ctrlKey: true } },
] as const;

const withModifier = (bindings: readonly KeyBinding[], modifier: "Meta" | "Ctrl"): KeyBinding[] => bindings.map((binding) => ({ ...binding, key: binding.key?.replace("Mod", modifier) }));

describe("QueryEditor search keymap precedence", () => {
  for (const { name, modifier, event: modifierEvent } of platforms) {
    it(`${name}: runs a configured editor action bound to Mod+F`, () => {
      const formatSql = vi.fn(() => true);
      const view = new EditorView({
        parent: document.createElement("div"),
        state: EditorState.create({
          extensions: [Prec.high(keymap.of([{ key: `${modifier}-f`, run: formatSql }, ...withModifier(createQueryEditorSearchKeymap({ openReplace: () => true, isReadOnly: () => false }), modifier)]))],
        }),
      });

      expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "f", ...modifierEvent }), "editor")).toBe(true);
      expect(formatSql).toHaveBeenCalledOnce();
      view.destroy();
    });

    it(`${name}: executes a custom Shift+Mod+R shortcut instead of the Mod+R replace binding`, () => {
      const openReplace = vi.fn(() => true);
      const executeSql = vi.fn(() => true);
      const view = new EditorView({
        parent: document.createElement("div"),
        state: EditorState.create({
          extensions: [
            Prec.high(
              EditorView.domEventHandlers({
                keydown: createQueryEditorReplaceShortcutHandler({ shortcut: "Mod+R", openReplace, isReadOnly: () => false }),
              }),
            ),
            Prec.high(
              keymap.of([
                ...withModifier(createQueryEditorReplaceShortcutBindings("Mod+R", openReplace), modifier),
                ...withModifier(
                  createQueryEditorExecutionShortcutBindings("Shift+Mod+R", executeSql, () => false),
                  modifier,
                ),
              ]),
            ),
          ],
        }),
      });

      const event = new KeyboardEvent("keydown", { key: "R", keyCode: 82, code: "KeyR", ...modifierEvent, shiftKey: true, bubbles: true, cancelable: true });
      Object.defineProperty(event, "keyCode", { get: () => 82 });
      view.contentDOM.dispatchEvent(event);
      expect(executeSql).toHaveBeenCalledOnce();
      expect(openReplace).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
      view.destroy();
    });

    it(`${name}: keeps the default Mod+R replace action working`, () => {
      const openReplace = vi.fn(() => true);
      const view = new EditorView({
        parent: document.createElement("div"),
        state: EditorState.create({
          extensions: [
            Prec.high(
              EditorView.domEventHandlers({
                keydown: createQueryEditorReplaceShortcutHandler({ shortcut: "Mod+R", openReplace, isReadOnly: () => false }),
              }),
            ),
          ],
        }),
      });

      const event = new KeyboardEvent("keydown", { key: "r", ...modifierEvent, bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(event);
      expect(openReplace).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(true);
      view.destroy();
    });

    it(`${name}: leaves Mod+F unhandled when the Find shortcut is cleared (#14623)`, () => {
      const view = new EditorView({
        parent: document.createElement("div"),
        state: EditorState.create({
          extensions: [keymap.of(withModifier(searchKeymapWithoutConfigurableBindings(searchKeymap), modifier)), Prec.high(keymap.of(withModifier(createQueryEditorSearchKeymap({ openReplace: () => true, isReadOnly: () => false }), modifier)))],
        }),
      });

      const event = new KeyboardEvent("keydown", { key: "f", ...modifierEvent, bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(event);
      // Not consumed: the event must reach app-level actions such as Focus search.
      expect(event.defaultPrevented).toBe(false);
      expect(searchPanelOpen(view.state)).toBe(false);
      view.destroy();
    });
  }
});
