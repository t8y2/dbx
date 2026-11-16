// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { createQueryEditorExecutionShortcutBindings, createQueryEditorExecutionShortcutHandler } from "../../editor/queryEditorExecutionShortcut";

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

  it("checks shortcut eligibility at dispatch time without rebuilding the keymap", () => {
    let enabled = false;
    const explain = vi.fn(() => true);
    const view = createView([createQueryEditorExecutionShortcutBindings("Mod+E", explain, isComposing, () => enabled)]);

    expect(runScopeHandlers(view, executeEvent("e"), "editor")).toBe(true);
    expect(explain).not.toHaveBeenCalled();

    enabled = true;
    expect(runScopeHandlers(view, executeEvent("e"), "editor")).toBe(true);
    expect(explain).toHaveBeenCalledOnce();

    enabled = false;
    expect(runScopeHandlers(view, executeEvent("e"), "editor")).toBe(true);
    expect(explain).toHaveBeenCalledOnce();
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

  describe("createQueryEditorExecutionShortcutHandler", () => {
    const shortcuts = {
      executeSql: "Mod+Enter",
      executeAllSql: "Alt+X",
      executeSqlInNewResultTab: "Mod+\\",
      explainSql: "Mod+E",
    };

    it("passes through non-repeated events when not executing", () => {
      const handler = createQueryEditorExecutionShortcutHandler({
        getShortcuts: () => shortcuts,
        isExecuting: () => false,
      });

      const event = executeEvent("Enter", { repeat: false });
      const preventDefault = vi.spyOn(event, "preventDefault");
      const stopPropagation = vi.spyOn(event, "stopPropagation");

      expect(handler(event)).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(stopPropagation).not.toHaveBeenCalled();
    });

    it("suppresses execution shortcuts when event.repeat is true", () => {
      const handler = createQueryEditorExecutionShortcutHandler({
        getShortcuts: () => shortcuts,
        isExecuting: () => false,
      });

      const event = executeEvent("Enter", { repeat: true });
      const preventDefault = vi.spyOn(event, "preventDefault");
      const stopPropagation = vi.spyOn(event, "stopPropagation");

      expect(handler(event)).toBe(true);
      expect(preventDefault).toHaveBeenCalled();
      expect(stopPropagation).toHaveBeenCalled();
    });

    it("suppresses execute all SQL shortcut when event.repeat is true or executing", () => {
      const handler = createQueryEditorExecutionShortcutHandler({
        getShortcuts: () => shortcuts,
        isExecuting: () => false,
      });

      const repeatEvent = new KeyboardEvent("keydown", {
        key: "x",
        code: "KeyX",
        altKey: true,
        repeat: true,
        bubbles: true,
        cancelable: true,
      });
      expect(handler(repeatEvent)).toBe(true);

      const executingHandler = createQueryEditorExecutionShortcutHandler({
        getShortcuts: () => shortcuts,
        isExecuting: () => true,
      });
      const executingEvent = new KeyboardEvent("keydown", {
        key: "x",
        code: "KeyX",
        altKey: true,
        repeat: false,
        bubbles: true,
        cancelable: true,
      });
      expect(executingHandler(executingEvent)).toBe(true);
    });

    it("suppresses execution shortcuts when isExecuting is true", () => {
      const handler = createQueryEditorExecutionShortcutHandler({
        getShortcuts: () => shortcuts,
        isExecuting: () => true,
      });

      const event = executeEvent("Enter", { repeat: false });
      const preventDefault = vi.spyOn(event, "preventDefault");
      const stopPropagation = vi.spyOn(event, "stopPropagation");

      expect(handler(event)).toBe(true);
      expect(preventDefault).toHaveBeenCalled();
      expect(stopPropagation).toHaveBeenCalled();
    });

    it("suppresses explain shortcut when enabled and isExecuting is true", () => {
      const handler = createQueryEditorExecutionShortcutHandler({
        getShortcuts: () => shortcuts,
        isExecuting: () => true,
        enableExplainShortcut: () => true,
      });

      const event = executeEvent("e", { repeat: false });
      expect(handler(event)).toBe(true);
    });

    it("does not suppress unrelated keys even if repeating", () => {
      const handler = createQueryEditorExecutionShortcutHandler({
        getShortcuts: () => shortcuts,
        isExecuting: () => true,
      });

      const event = new KeyboardEvent("keydown", { key: "a", repeat: true });
      expect(handler(event)).toBe(false);
    });
  });
});
