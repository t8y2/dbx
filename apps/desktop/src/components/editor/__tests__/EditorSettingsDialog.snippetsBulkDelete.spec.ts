import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../EditorSettingsDialog.vue", import.meta.url), "utf8");

describe("EditorSettingsDialog snippet bulk selection and delete", () => {
  it("renders a checkbox column with a select-all header toggle", () => {
    expect(dialogSource).toContain(':checked="selectedSnippetIds.has(snippet.id)"');
    expect(dialogSource).toContain('@click="handleSnippetCheckboxClick($event, snippet)"');
    expect(dialogSource).toContain(':checked="allSnippetsSelected"');
    expect(dialogSource).toContain("aria-label=\"t('settings.snippetsSelectAll')\"");
  });

  it("offers a bulk delete button that confirms before removing the selected rows", () => {
    expect(dialogSource).toContain('t("settings.snippetsDeleteSelected"');
    const block = dialogSource.slice(dialogSource.indexOf("function deleteSelectedSnippets()"), dialogSource.indexOf("function openAddSqlShortcutDialog()"));
    expect(block).toContain("window.confirm(");
    expect(block).toContain("editSnippets.value.filter((snippet) => !selectedSnippetIds.value.has(snippet.id))");
    expect(block).toContain("selectedSnippetIds.value = new Set();");
  });

  it("drops rows removed individually from the selection", () => {
    const block = dialogSource.slice(dialogSource.indexOf("function deleteSnippet(id: string)"), dialogSource.indexOf("function confirmDeleteSnippet"));
    expect(block).toContain("selectedSnippetIds.value.delete(id);");
  });

  it("supports shift-click range selection anchored at the last plain click", () => {
    expect(dialogSource).toContain('@click="handleSnippetCheckboxClick($event, snippet)"');
    expect(dialogSource).toContain('@change="handleSnippetCheckboxChange(snippet, ($event.target as HTMLInputElement).checked)"');
    const block = dialogSource.slice(dialogSource.indexOf("function handleSnippetCheckboxClick"), dialogSource.indexOf("function toggleAllSnippetsSelected"));
    // click only decides whether a range can form and tracks the anchor; change
    // spreads the clicked row's post-toggle state across the span
    expect(block).toContain("applySnippetRangeSelection(selectedSnippetIds.value, visibleSnippets.value, snippetSelectionAnchorId, snippet.id, checked)");
    expect(block).toContain("snippetRangeClickPending");
    expect(block).toContain("snippetSelectionAnchorId = snippet.id");
    expect(dialogSource).toContain('from "@/lib/sql/snippetRangeSelection"');
  });

  it("rides the native checkbox toggle instead of canceling it", () => {
    // WebView2 rebounds a canceled checkbox click after the render falls back:
    // the clicked row is checked by the binding and then bounced back to
    // unchecked. Both designs that canceled the native toggle lost that race,
    // so the handlers follow the native toggle instead — whatever the clicked
    // row toggles to, the shift range follows, and visuals cannot diverge.
    const block = dialogSource.slice(dialogSource.indexOf("function handleSnippetCheckboxClick"), dialogSource.indexOf("function toggleAllSnippetsSelected"));
    expect(block).not.toContain("preventDefault");
    expect(block).toContain("if (checked) update.add(snippet.id)");
    expect(block).toContain("else update.delete(snippet.id)");
  });
});
