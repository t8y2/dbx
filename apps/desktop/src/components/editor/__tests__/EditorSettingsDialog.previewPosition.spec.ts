import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../EditorSettingsDialog.vue", import.meta.url), "utf8");
const editorSectionStart = dialogSource.indexOf(`activeSettingsTab === 'editor'`);
const formatterSectionStart = dialogSource.indexOf(`activeSettingsTab === 'formatter'`, editorSectionStart);
const editorSection = dialogSource.slice(editorSectionStart, formatterSectionStart);
const dataSectionStart = dialogSource.indexOf(`activeSettingsTab === 'data'`);
const shortcutsSectionStart = dialogSource.indexOf(`activeSettingsTab === 'shortcuts'`, dataSectionStart);
const dataSection = dialogSource.slice(dataSectionStart, shortcutsSectionStart);

describe("EditorSettingsDialog live preview placement", () => {
  it("renders preview-linked controls after appearance settings and before the live preview", () => {
    const fontFamily = editorSection.indexOf('t("settings.fontFamily")');
    const theme = editorSection.indexOf('t("settings.theme")');
    const fontSize = editorSection.indexOf('t("settings.fontSize")');
    const previewControls = editorSection.indexOf("data-editor-preview-controls");
    const preview = editorSection.indexOf('ref="previewRef"');
    const executeMode = editorSection.indexOf("executeModeLabel");

    expect(editorSectionStart).toBeGreaterThanOrEqual(0);
    expect(formatterSectionStart).toBeGreaterThan(editorSectionStart);
    expect(fontFamily).toBeGreaterThanOrEqual(0);
    expect(theme).toBeGreaterThan(fontFamily);
    expect(fontSize).toBeGreaterThan(theme);
    expect(previewControls).toBeGreaterThan(fontSize);
    expect(preview).toBeGreaterThan(previewControls);
    expect(preview).toBeLessThan(executeMode);
    expect(editorSection.match(/ref="previewRef"/g)).toHaveLength(1);

    for (const id of ["editor-show-statement-run-buttons", "editor-show-line-numbers", "editor-show-current-statement-frame", "editor-sql-semantic-diagnostics"]) {
      expect(editorSection.indexOf(`id="${id}"`)).toBeGreaterThan(previewControls);
      expect(editorSection.indexOf(`id="${id}"`)).toBeLessThan(preview);
      expect(editorSection.match(new RegExp(`id="${id}"`, "g"))).toHaveLength(1);
    }
  });

  it("keeps the preview lifecycle tied to the same template ref", () => {
    expect(dialogSource).toContain("watch(previewRef, async (el) => {");
    expect(dialogSource).toContain("cleanupPreviewEditor();");
  });

  it("places execution behavior before SQL completion with high-priority controls first", () => {
    const preview = editorSection.indexOf('ref="previewRef"');
    const completionSection = editorSection.indexOf("data-editor-sql-completion-settings");
    const completionTriggerMode = editorSection.indexOf('t("settings.completionTriggerMode")');
    const selectFirstCompletion = editorSection.indexOf('t("settings.selectFirstCompletionOnOpen")');
    const executionSection = editorSection.indexOf("data-editor-execution-settings");
    const executeMode = editorSection.indexOf("executeModeLabel", executionSection);

    expect(executionSection).toBeGreaterThan(preview);
    expect(executeMode).toBeGreaterThan(executionSection);
    expect(completionSection).toBeGreaterThan(executeMode);
    expect(completionTriggerMode).toBeGreaterThan(completionSection);
    expect(selectFirstCompletion).toBeGreaterThan(completionTriggerMode);
    expect(editorSection).not.toContain('t("settings.sqlCompletionSection")');
    expect(editorSection).toContain('class="flex items-start justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2" data-editor-completion-trigger-mode');
    expect(editorSection).toContain('<SelectTrigger class="h-8 w-44 shrink-0">');
    expect(editorSection).toContain('class="grid gap-4 md:grid-cols-2" data-editor-execution-settings');
    expect(editorSection).toContain('class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2 md:col-span-2" data-editor-execute-mode');
    expect(editorSection.match(/:model-value="editCompletionTriggerMode"/g)).toHaveLength(1);
    expect(editorSection.match(/id="editor-select-first-completion-on-open"/g)).toHaveLength(1);
  });

  it("groups related execution and unsaved SQL controls without removing saved-target behavior", () => {
    const executionGroup = editorSection.indexOf("data-editor-execution-settings");
    const executionGroupEnd = editorSection.indexOf("data-editor-sql-completion-settings", executionGroup);
    const unsavedGroup = editorSection.indexOf("data-editor-unsaved-sql-settings");
    const unsavedGroupEnd = editorSection.indexOf("generate-sql-include-database-name", unsavedGroup);

    for (const id of ["editor-execute-all-on-blank-line", "editor-show-execution-target-picker", "editor-confirm-dangerous-sql", "editor-continue-on-error"]) {
      expect(editorSection.indexOf(`id="${id}"`)).toBeGreaterThan(executionGroup);
      expect(editorSection.indexOf(`id="${id}"`)).toBeLessThan(executionGroupEnd);
      expect(editorSection.match(new RegExp(`id="${id}"`, "g"))).toHaveLength(1);
    }
    for (const id of ["editor-confirm-unsaved-sql-close", "app-close-unsaved-tabs-mode"]) {
      expect(editorSection.indexOf(`id="${id}"`)).toBeGreaterThan(unsavedGroup);
      expect(editorSection.indexOf(`id="${id}"`)).toBeLessThan(unsavedGroupEnd);
    }
    expect(editorSection).toContain('id="editor-saved-sql-open-target"');
    expect(editorSection).toContain('class="flex min-w-0 items-start justify-between gap-4"');
    expect(editorSection).toContain('id="app-close-unsaved-tabs-mode" class="h-8 w-44 shrink-0"');
    expect(editorSection).not.toContain('id="editor-click-table-navigation-ddl"');
    expect(editorSection).not.toContain('id="editor-prefill-new-query"');
  });

  it("describes the execute shortcut below the mode selector in every supported locale", () => {
    expect(editorSection.indexOf("executeModeDescription")).toBeGreaterThan(editorSection.indexOf('ref="previewRef"'));

    for (const locale of ["zh-CN", "zh-TW", "en", "es", "it", "ja", "ko", "pt-BR"]) {
      const source = readFileSync(new URL(`../../../i18n/locales/${locale}.ts`, import.meta.url), "utf8");
      expect(source, locale).toContain("executeModeDescription:");
    }
  });

  it("shows a concise description for the selected completion trigger mode", () => {
    expect(dialogSource).toContain("const completionTriggerModeDescription = computed(() => {");
    expect(editorSection).toContain("{{ completionTriggerModeDescription }}");
    expect(editorSection).not.toContain('t("settings.completionTriggerModeDescription")');

    for (const locale of ["zh-CN", "zh-TW", "en", "es", "it", "ja", "ko", "pt-BR"]) {
      const source = readFileSync(new URL(`../../../i18n/locales/${locale}.ts`, import.meta.url), "utf8");
      for (const key of ["completionTriggerModeManualDescription", "completionTriggerModeRequirePrefixDescription", "completionTriggerModePositionalDescription"]) {
        expect(source, `${locale}:${key}`).toContain(`${key}:`);
      }
    }
  });

  it("moves table navigation and query prefill controls to Navigation", () => {
    const navigationSection = dialogSource.slice(dialogSource.indexOf(`activeSettingsTab === 'navigation'`));

    for (const id of ["editor-click-table-navigation-ddl", "editor-prefill-new-query"]) {
      expect(navigationSection).toContain(`id="${id}"`);
      expect(dialogSource.match(new RegExp(`id="${id}"`, "g"))).toHaveLength(1);
    }
  });

  it("groups navigation settings by data tabs and sidebar browsing flow", () => {
    const navigationSection = dialogSource.slice(dialogSource.indexOf(`activeSettingsTab === 'navigation'`));
    const adjacentDataTabs = navigationSection.indexOf('id="open-data-tabs-next-to-active"');
    const objectDisplay = navigationSection.indexOf('t("settings.sidebarObjectDisplay")');
    const routineOpenMode = navigationSection.indexOf('t("settings.routineSourceOpenMode")');
    const tableNavigation = navigationSection.indexOf('id="editor-click-table-navigation-ddl"');
    const openDatabaseOnClick = navigationSection.indexOf('id="sidebar-open-database-on-single-click"');
    const tableSearch = navigationSection.indexOf('id="sidebar-table-search-enabled"');
    const activeNodeSelection = navigationSection.indexOf('id="auto-select-active-sidebar-node"');

    expect(adjacentDataTabs).toBeGreaterThanOrEqual(0);
    expect(objectDisplay).toBeGreaterThan(adjacentDataTabs);
    expect(routineOpenMode).toBeGreaterThan(objectDisplay);
    expect(tableNavigation).toBeGreaterThan(routineOpenMode);
    expect(openDatabaseOnClick).toBeGreaterThan(tableNavigation);
    expect(tableSearch).toBeGreaterThan(openDatabaseOnClick);
    expect(activeNodeSelection).toBeGreaterThan(tableSearch);
  });

  it("puts the data grid filter view first with flat choices and a live preview", () => {
    const filterView = dataSection.indexOf('data-settings-search-id="data-grid-filter-view"');
    const dataGridDisplay = dataSection.indexOf('t("settings.dataGridDisplay")');

    expect(dataSectionStart).toBeGreaterThanOrEqual(0);
    expect(shortcutsSectionStart).toBeGreaterThan(dataSectionStart);
    expect(filterView).toBeGreaterThanOrEqual(0);
    expect(filterView).toBeLessThan(dataGridDisplay);
    expect(dataSection).toContain(`:class="['overflow-hidden rounded-md border bg-muted/20', settingsSearchTargetClass('data-grid-filter-view')]"`);
    expect(dataSection).toContain("data-data-grid-filter-view-options");
    expect(dataSection).toContain('v-if="dataGridFilterViewPreviewExpanded" class="pointer-events-none select-none overflow-hidden border-t bg-background" data-data-grid-filter-view-preview');
    expect(dataSection).toContain("data-data-grid-filter-view-preview-toggle");
    expect(dataSection).toContain(':aria-expanded="dataGridFilterViewPreviewExpanded"');
    expect(dataSection).toContain('t("settings.dataGridFilterViewPreview")');
    expect(dataSection).toContain("dataGridFilterViewPreviewExpanded = !dataGridFilterViewPreviewExpanded");
    expect(dataSection).toContain("data-data-grid-filter-preview-quick");
    expect(dataSection).toContain("data-data-grid-filter-preview-conditions");
    expect(dataSection).toContain("data-data-grid-filter-preview-text");
    expect(dataSection.match(/editDataGridFilterEditorView = '(quick|conditions|text)'/g)).toHaveLength(3);
    expect(dataSection).not.toContain('<SelectTrigger id="data-grid-filter-view"');

    for (const locale of ["zh-CN", "zh-TW", "en", "es", "it", "ja", "ko", "pt-BR"]) {
      const source = readFileSync(new URL(`../../../i18n/locales/${locale}.ts`, import.meta.url), "utf8");
      for (const key of ["dataGridFilterViewPreview", "dataGridFilterViewPreviewExpand", "dataGridFilterViewPreviewCollapse"]) {
        expect(source, `${locale}:${key}`).toContain(`${key}:`);
      }
    }
  });

  it("updates preview line-number visibility from the unsaved editor draft", () => {
    expect(dialogSource).toContain("showLineNumbers: editShowLineNumbers.value");
    expect(dialogSource).toContain('import { buildQueryEditorLineNumbersExtension } from "@/lib/editor/queryEditorLineNumbers";');
    expect(dialogSource).toContain('let previewLineNumbersComp: import("@codemirror/state").Compartment | null = null;');
    expect(dialogSource).toContain('const previewBasicSetup = (basicSetup as readonly import("@codemirror/state").Extension[]).slice(2);');
    expect(dialogSource).toContain("previewLineNumbersComp.of(buildPreviewLineNumbersExtension(ss.showLineNumbers))");
    expect(dialogSource).toContain("previewLineNumbersComp.reconfigure(buildPreviewLineNumbersExtension(ss.showLineNumbers))");
    expect(dialogSource).toContain("return buildQueryEditorLineNumbersExtension(previewLineNumbersFactory, enabled");
  });

  it("creates the preview editor as read-only so demo edits cannot desync the Apply buttons", () => {
    expect(dialogSource).toContain("EditorState.readOnly.of(true)");
    expect(dialogSource).toContain("EditorView.editable.of(false)");
    expect(dialogSource).toContain('EditorView.contentAttributes.of({ tabindex: "0" })');
  });

  it("explains the intentional syntax-error demo below the preview when diagnostics are enabled", () => {
    const preview = editorSection.indexOf('ref="previewRef"');
    expect(editorSection).toContain('v-if="editSqlSemanticDiagnosticsEnabled"');
    expect(editorSection.indexOf('t("settings.previewSyntaxErrorHint")')).toBeGreaterThan(preview);
  });

  it.each(["en", "zh-CN", "zh-TW", "es", "pt-BR", "it", "ja", "ko"])("locale %s translates settings.previewSyntaxErrorHint", (locale) => {
    const localeSource = readFileSync(new URL(`../../../i18n/locales/${locale}.ts`, import.meta.url), "utf8");
    expect(localeSource).toMatch(/previewSyntaxErrorHint: ".+"/);
  });
});
