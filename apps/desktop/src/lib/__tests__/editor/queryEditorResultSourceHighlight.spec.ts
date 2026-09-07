import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

// Regression test for issue #8096: clicking a long SQL statement in the
// execution-summary panel (previewStatementRange) used to only recolor the
// gutter line number, which is easy to miss and reads as "click does
// nothing" for statements that are already scrolled into view. The fix adds
// a visible text-highlight decoration alongside the existing gutter marker.
describe("QueryEditor result-source preview highlight", () => {
  it("builds a highlight decoration field in addition to the gutter line-number field", () => {
    const extensionStart = queryEditorSource.indexOf("buildResultSourceRangeExtension = () => {");
    expect(extensionStart).toBeGreaterThan(-1);
    const extensionEnd = queryEditorSource.indexOf("\n  };", extensionStart);
    const extensionBody = queryEditorSource.slice(extensionStart, extensionEnd);

    expect(extensionBody).toContain("lineNumberMarkers.from(field)");
    expect(extensionBody).toContain("const highlightField = StateField.define({");
    expect(extensionBody).toContain('Decoration.mark({ class: "cm-db-result-source-highlight" })');
    expect(extensionBody).toContain("EditorView.decorations.from(field)");
    expect(extensionBody).toContain("return [field, highlightField];");
  });

  it("drives both the gutter marker and the highlight decoration from the same effect", () => {
    const extensionStart = queryEditorSource.indexOf("buildResultSourceRangeExtension = () => {");
    const extensionEnd = queryEditorSource.indexOf("\n  };", extensionStart);
    const extensionBody = queryEditorSource.slice(extensionStart, extensionEnd);
    const effectUses = extensionBody.match(/effect\.is\(effectType\)/g) ?? [];

    expect(effectUses.length).toBe(2);
  });

  it("defines a visible background style for the highlight class", () => {
    expect(queryEditorSource).toMatch(/:deep\(\.cm-db-result-source-highlight\)\s*{\s*background:/);
  });

  it("keeps previewStatementRange wired to setResultSourceRangeEffect via setResultSourceRange", () => {
    const fnStart = queryEditorSource.indexOf("function previewStatementRange(");
    const fnEnd = queryEditorSource.indexOf("\n}", fnStart);
    const fnBody = queryEditorSource.slice(fnStart, fnEnd);

    expect(fnBody).toContain("setResultSourceRangeEffect.of({ from, to })");
  });
});
