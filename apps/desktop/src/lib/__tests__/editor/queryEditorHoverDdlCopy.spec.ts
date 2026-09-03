import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

describe("QueryEditor hover DDL copy", () => {
  it("gates only the table DDL branch on the preference, keeping column hover", () => {
    expect(queryEditorSource).not.toContain("if (!settingsStore.editorSettings.showTableDdlHoverPreview) return null;");
    expect(queryEditorSource).toContain("if (table && settingsStore.editorSettings.showTableDdlHoverPreview && !semanticQualifierIsRowSource");
  });

  it("adds an accessible copy button that preserves SQL whitespace semantics", () => {
    expect(queryEditorSource).toContain('copyButton.textContent = t("grid.copyDdl");');
    expect(queryEditorSource).toContain('copyButton.setAttribute("aria-label", t("grid.copyDdl"));');
    expect(queryEditorSource).toContain('copyButton.addEventListener("pointerdown"');
    expect(queryEditorSource).toContain("event.stopPropagation();");
    expect(queryEditorSource).toContain("await copyToClipboard(normalizeAlignedSqlWhitespace(sqlContent));");
    expect(queryEditorSource).toContain('toast(t("contextMenu.ddlCopied"), 2000);');
    expect(queryEditorSource).toContain('toast(t("grid.copyFailed", { message: error?.message || String(error) }), 5000);');
  });
});
