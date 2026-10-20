// @vitest-environment happy-dom

import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { handleQueryEditorCompletionNavigation, queryEditorCompletionNavigationDirection } from "@/lib/editor/queryEditorCompletionNavigation";

function event(key: string, modifiers: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, ctrlKey: true, cancelable: true, ...modifiers });
}

describe("queryEditorCompletionNavigation", () => {
  it("maps only plain Ctrl-N and Ctrl-P to completion navigation", () => {
    expect(queryEditorCompletionNavigationDirection(event("n"))).toBe(true);
    expect(queryEditorCompletionNavigationDirection(event("P"))).toBe(false);
    expect(queryEditorCompletionNavigationDirection(event("n", { ctrlKey: false }))).toBeNull();
    expect(queryEditorCompletionNavigationDirection(event("n", { metaKey: true }))).toBeNull();
    expect(queryEditorCompletionNavigationDirection(event("n", { altKey: true }))).toBeNull();
    expect(queryEditorCompletionNavigationDirection(event("n", { shiftKey: true }))).toBeNull();
    expect(queryEditorCompletionNavigationDirection(event("x"))).toBeNull();
  });

  it("ignores keys while an IME composition is active", () => {
    expect(queryEditorCompletionNavigationDirection({ key: "n", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: true })).toBeNull();
    expect(queryEditorCompletionNavigationDirection({ key: "p", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: true })).toBeNull();
  });

  it("moves the active completion and consumes the key only when CodeMirror handled it", () => {
    const view = {} as EditorView;
    const next = vi.fn(() => true);
    const previous = vi.fn(() => false);
    const moveCompletionSelection = vi.fn((forward: boolean) => (forward ? next : previous));

    const nextEvent = event("n");
    expect(handleQueryEditorCompletionNavigation(view, nextEvent, moveCompletionSelection)).toBe(true);
    expect(moveCompletionSelection).toHaveBeenCalledWith(true);
    expect(next).toHaveBeenCalledWith(view);
    expect(nextEvent.defaultPrevented).toBe(true);

    const previousEvent = event("p");
    expect(handleQueryEditorCompletionNavigation(view, previousEvent, moveCompletionSelection)).toBe(false);
    expect(moveCompletionSelection).toHaveBeenCalledWith(false);
    expect(previous).toHaveBeenCalledWith(view);
    expect(previousEvent.defaultPrevented).toBe(false);
  });
});
