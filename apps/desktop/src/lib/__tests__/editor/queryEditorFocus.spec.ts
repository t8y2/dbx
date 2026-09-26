import { describe, expect, it, vi } from "vitest";
import { focusEditorView, type EditorViewLike } from "@/lib/editor/queryEditorFocus";

function createMockView(overrides: Partial<EditorViewLike> = {}): EditorViewLike {
  return {
    hasFocus: false,
    focus: vi.fn(),
    ...overrides,
  };
}

describe("focusEditorView", () => {
  it("focuses the editor when view exists and does not have focus", () => {
    const view = createMockView({ hasFocus: false });
    const result = focusEditorView(view);
    expect(result).toBe(true);
    expect(view.focus).toHaveBeenCalledOnce();
  });

  it("skips focus when the editor already has focus", () => {
    const view = createMockView({ hasFocus: true });
    const result = focusEditorView(view);
    expect(result).toBe(false);
    expect(view.focus).not.toHaveBeenCalled();
  });

  it("returns false when view is null", () => {
    expect(focusEditorView(null)).toBe(false);
  });

  it("returns false when view is undefined", () => {
    expect(focusEditorView(undefined)).toBe(false);
  });
});
