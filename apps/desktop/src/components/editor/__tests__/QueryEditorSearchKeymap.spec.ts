// @vitest-environment happy-dom

// pi-lens-ignore: typescript:2307
import { EditorState, Prec } from "@codemirror/state";
// pi-lens-ignore: typescript:2307
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
// pi-lens-ignore: typescript:2307
import { describe, expect, it, vi } from "vitest";
// pi-lens-ignore: typescript:2307
import { createQueryEditorExecutionShortcutBindings } from "@/lib/editor/queryEditorExecutionShortcut";
// pi-lens-ignore: typescript:2307
import { createQueryEditorReplaceShortcutBindings, createQueryEditorReplaceShortcutHandler, createQueryEditorSearchKeymap } from "@/lib/editor/queryEditorSearchKeymap";

describe("QueryEditor search keymap precedence", () => {
  it("runs configured editor actions before the built-in search fallback", () => {
    const formatSql = vi.fn(() => true);
    const openSearch = vi.fn(() => true);
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        extensions: [Prec.high(keymap.of([{ key: "Mod-f", run: formatSql }, ...createQueryEditorSearchKeymap({ openSearch, openReplace: () => true, isReadOnly: () => false })]))],
      }),
    });

    expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "f", ctrlKey: true }), "editor")).toBe(true);
    expect(formatSql).toHaveBeenCalledOnce();
    expect(openSearch).not.toHaveBeenCalled();
    view.destroy();
  });

  it("executes a custom Shift+Mod+R shortcut instead of the Mod+R replace binding", () => {
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
          Prec.high(keymap.of([...createQueryEditorReplaceShortcutBindings("Mod+R", openReplace), ...createQueryEditorExecutionShortcutBindings("Shift+Mod+R", executeSql, () => false)])),
        ],
      }),
    });

    const event = new KeyboardEvent("keydown", { key: "r", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);
    expect(executeSql).toHaveBeenCalledOnce();
    expect(openReplace).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    view.destroy();
  });

  it("keeps the default Mod+R replace action working", () => {
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

    const event = new KeyboardEvent("keydown", { key: "r", ctrlKey: true, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);
    expect(openReplace).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    view.destroy();
  });

  it("keeps the search fallback above lower-priority CodeMirror bindings", () => {
    const openSearch = vi.fn(() => true);
    const lowerPrioritySearch = vi.fn(() => true);
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        extensions: [keymap.of([{ key: "Mod-f", run: lowerPrioritySearch }]), Prec.high(keymap.of(createQueryEditorSearchKeymap({ openSearch, openReplace: () => true, isReadOnly: () => false })))],
      }),
    });

    expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "f", ctrlKey: true }), "editor")).toBe(true);
    expect(openSearch).toHaveBeenCalledOnce();
    expect(lowerPrioritySearch).not.toHaveBeenCalled();
    view.destroy();
  });
});
