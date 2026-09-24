import { describe, expect, it } from "vitest";
import { needsDiagnosticCaretReanchor, type DiagnosticCaretAnchorState } from "@/lib/editor/queryEditorDiagnosticCaretAnchor";

const textNode = { nodeType: 3, name: "text" } as unknown as Node;
const lineNode = { nodeType: 1, name: "line" } as unknown as Node;

function state(overrides: Partial<DiagnosticCaretAnchorState> = {}): DiagnosticCaretAnchorState {
  return {
    hasFocus: true,
    composing: false,
    domRangeCount: 1,
    currentAnchorNode: lineNode,
    currentAnchorOffset: 2,
    targetNode: textNode,
    targetOffset: 3,
    ...overrides,
  };
}

describe("needsDiagnosticCaretReanchor", () => {
  it("re-anchors when the browser caret collapsed onto the surrounding line element", () => {
    // The reported case: `document.getSelection()` reports (line, childCount)
    // while the caret really sits inside the text node.
    expect(needsDiagnosticCaretReanchor(state())).toBe(true);
  });

  it("re-anchors when the browser caret sits on the wrong offset of the same node", () => {
    expect(needsDiagnosticCaretReanchor(state({ currentAnchorNode: textNode, currentAnchorOffset: 0 }))).toBe(true);
  });

  it("keeps a caret that already matches the precise DOM position", () => {
    expect(needsDiagnosticCaretReanchor(state({ currentAnchorNode: textNode, currentAnchorOffset: 3 }))).toBe(false);
  });

  it("does not touch the caret while an IME composition is running", () => {
    expect(needsDiagnosticCaretReanchor(state({ composing: true }))).toBe(false);
  });

  it("does not touch the caret when the editor is not focused", () => {
    expect(needsDiagnosticCaretReanchor(state({ hasFocus: false }))).toBe(false);
  });

  it("keeps non-empty selections and multiple cursors untouched", () => {
    expect(needsDiagnosticCaretReanchor(state({ targetNode: null }))).toBe(false);
    expect(needsDiagnosticCaretReanchor(state({ domRangeCount: 2 }))).toBe(false);
    expect(needsDiagnosticCaretReanchor(state({ domRangeCount: 0, currentAnchorNode: null }))).toBe(false);
  });
});
