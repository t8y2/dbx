import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const editorSource = readFileSync(new URL("../QueryEditor.vue", import.meta.url), "utf8");
const menuSource = readFileSync(new URL("../QueryEditorContextMenu.vue", import.meta.url), "utf8");
const dialogSource = readFileSync(new URL("../SnippetQuickAddDialog.vue", import.meta.url), "utf8");
const enSource = readFileSync(new URL("../../../i18n/locales/en.ts", import.meta.url), "utf8");
const zhCnSource = readFileSync(new URL("../../../i18n/locales/zh-CN.ts", import.meta.url), "utf8");

describe("QueryEditor snippet quick-add wiring", () => {
  it("adds an always-available context-menu entry after the delimited-list action", () => {
    const entryStart = menuSource.indexOf('label: t("editor.contextMenu.addSnippet")');
    expect(entryStart).toBeGreaterThan(-1);
    const entryEnd = menuSource.indexOf("\n    },", entryStart);
    const entry = menuSource.slice(entryStart, entryEnd);
    expect(entry).toContain("action: actions.openSnippetQuickAddDialog");
    expect(entry).toContain("icon: ListPlus");
    // Saving a snippet never touches editor content, so the entry stays enabled
    // in read-only editors and without a selection (the body just starts empty).
    expect(entry).not.toContain("disabled:");
    // The editor wires the dialog opener through the shared actions object.
    expect(menuSource).toContain("openSnippetQuickAddDialog: () => void;");
    expect(editorSource).toContain("  openSnippetQuickAddDialog,");

    const delimitedIndex = menuSource.indexOf('label: t("editor.contextMenu.delimitedList")');
    expect(delimitedIndex).toBeGreaterThan(-1);
    expect(entryStart).toBeGreaterThan(delimitedIndex);
  });

  it("prefills the dialog body from the right-click selection and mounts the dialog", () => {
    const fnStart = editorSource.indexOf("function openSnippetQuickAddDialog");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = editorSource.indexOf("\n}", fnStart);
    const fnSource = editorSource.slice(fnStart, fnEnd);
    expect(fnSource).toContain('snippetQuickAddPrefillBody.value = selectedSql.value.trim() ? selectedSql.value : "";');

    expect(editorSource).toContain('<SnippetQuickAddDialog v-model:open="snippetQuickAddOpen" :prefill-body="snippetQuickAddPrefillBody" />');
    expect(editorSource).toContain('import SnippetQuickAddDialog from "./SnippetQuickAddDialog.vue";');
  });

  it("keeps Enter-to-confirm and a single submit button in the dialog", () => {
    expect(dialogSource).toContain('@submit.prevent="save"');
    const formIndex = dialogSource.indexOf('<form ref="formRef"');
    expect(formIndex).toBeGreaterThan(-1);
    expect(dialogSource.indexOf("<DialogHeader>", formIndex)).toBeGreaterThan(formIndex);
    expect(dialogSource.indexOf("<DialogFooter>", formIndex)).toBeGreaterThan(formIndex);
    expect(dialogSource.indexOf("</form>", formIndex)).toBeGreaterThan(dialogSource.indexOf("<DialogFooter>", formIndex));
    expect(dialogSource).toContain('<Button type="submit" :disabled="!trimmedPrefix || duplicatePrefix">');
    expect(dialogSource).toContain('<Button type="button" variant="outline" @click="open = false">');
  });

  it("validates duplicates before the store's first-wins snippet normalizer", () => {
    expect(dialogSource).toContain("settingsStore.editorSettings.snippets.some((snippet) => snippet.prefix === trimmedPrefix.value)");
    expect(dialogSource).toContain("settingsStore.updateEditorSettings({ snippets: [...settingsStore.editorSettings.snippets, snippet] })");
  });

  it("ships the menu entry and dialog strings in both locales", () => {
    expect(enSource).toContain('addSnippet: "Add snippet"');
    expect(zhCnSource).toContain('addSnippet: "添加片段"');
    ["prefixUnique", "saved:"].forEach((key) => {
      expect(enSource).toContain(key);
      expect(zhCnSource).toContain(key);
    });
  });
});
