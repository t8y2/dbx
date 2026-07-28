import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { focusEditorView, type EditorViewLike } from "@/lib/editor/queryEditorFocus";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");
const contentAreaSource = readFileSync(new URL("../../../components/layout/ContentArea.vue", import.meta.url), "utf8");

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

describe("QueryEditor auto focus wiring", () => {
  it("keeps auto focus opt-in for shared editor instances", () => {
    expect(queryEditorSource).toContain("autoFocus?: boolean;");
    expect(queryEditorSource).toMatch(/if \(props\.autoFocus\) \{[\s\S]*focusEditorView\(view\.value\);/);
  });

  it("enables auto focus for query tabs", () => {
    expect(contentAreaSource).toMatch(/<QueryEditor[\s\S]*?\sauto-focus\s[\s\S]*?:model-value="activeTab\.sql"/);
  });
});
