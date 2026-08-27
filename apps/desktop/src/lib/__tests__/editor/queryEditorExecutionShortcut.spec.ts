// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { createQueryEditorExecutionShortcutBindings } from "../../editor/queryEditorExecutionShortcut";

function createView(bindings: ReturnType<typeof createQueryEditorExecutionShortcutBindings>[]): EditorView {
  return new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({
      extensions: [keymap.of(bindings.flat())],
    }),
  });
}

function executeEvent(key: string, options: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    code: key === "Enter" ? "Enter" : "Backslash",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  });
}

const isComposing = (view: EditorView): boolean => view.compositionStarted || view.composing;

describe("QueryEditor execution shortcuts", () => {
  it("executes the normal SQL shortcut when no IME composition is active", () => {
    const execute = vi.fn(() => true);
    const view = createView([createQueryEditorExecutionShortcutBindings("Mod+Enter", execute, isComposing)]);

    expect(view.composing).toBe(false);
    expect(runScopeHandlers(view, executeEvent("Enter"), "editor")).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(view);
    view.destroy();
  });

  it("consumes the SQL shortcut without executing during IME composition", () => {
    const execute = vi.fn(() => true);
    const view = createView([createQueryEditorExecutionShortcutBindings("Mod+Enter", execute, isComposing)]);

    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const startedEvent = executeEvent("Enter");
    view.contentDOM.dispatchEvent(startedEvent);
    expect(startedEvent.defaultPrevented).toBe(true);
    (view as EditorView & { inputState: { composing: number } }).inputState.composing = 1;

    expect(view.composing).toBe(true);
    expect(runScopeHandlers(view, executeEvent("Enter"), "editor")).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    view.destroy();
  });

  it("suppresses both execution destinations while composing", () => {
    const execute = vi.fn(() => true);
    const executeInNewResultTab = vi.fn(() => true);
    const view = createView([createQueryEditorExecutionShortcutBindings("Mod+Enter", execute, isComposing), createQueryEditorExecutionShortcutBindings("Mod+\\", executeInNewResultTab, isComposing)]);

    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    (view as EditorView & { inputState: { composing: number } }).inputState.composing = 1;

    expect(runScopeHandlers(view, executeEvent("Enter"), "editor")).toBe(true);
    expect(runScopeHandlers(view, executeEvent("\\"), "editor")).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(executeInNewResultTab).not.toHaveBeenCalled();
    view.destroy();
  });

  it("restores both execution shortcuts after composition ends", () => {
    const execute = vi.fn(() => true);
    const executeInNewResultTab = vi.fn(() => true);
    const view = createView([createQueryEditorExecutionShortcutBindings("Mod+Enter", execute, isComposing), createQueryEditorExecutionShortcutBindings("Mod+\\", executeInNewResultTab, isComposing)]);

    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    (view as EditorView & { inputState: { composing: number } }).inputState.composing = 1;
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));

    expect(view.composing).toBe(false);
    expect(view.compositionStarted).toBe(false);
    expect(runScopeHandlers(view, executeEvent("Enter"), "editor")).toBe(true);
    expect(runScopeHandlers(view, executeEvent("\\"), "editor")).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(executeInNewResultTab).toHaveBeenCalledOnce();
    view.destroy();
  });
});
