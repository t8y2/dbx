import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import { DEFAULT_SQL_FORMATTER_SETTINGS } from "../../apps/desktop/src/lib/sql/sqlFormatterConfig.ts";
import { DEFAULT_TABLE_COLUMN_TEMPLATE_FIELDS } from "../../apps/desktop/src/lib/table/tableColumnTemplates.ts";
import { DEFAULT_UI_FONT_FAMILY, SYSTEM_UI_FONT_FAMILY } from "../../apps/desktop/src/lib/app/appFonts.ts";
import { tableOpenPageLimit } from "../../apps/desktop/src/lib/table/tableOpenPageLimit.ts";
import { AI_PROVIDER_PRESETS, DEFAULT_EDITOR_SETTINGS, EXECUTE_MODE_CURRENT_DEFAULT_VERSION, normalizeAiConfig, normalizeEditorSettings, useSettingsStore } from "../../apps/desktop/src/stores/settingsStore.ts";

const OLD_FONT_SIZE_KEY = "dbx-query-editor-font-size";

async function withMockLocalStorage(initial: Record<string, string>, run: () => void | Promise<void>) {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map(Object.entries(initial));
  const localStorageMock = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
  };

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorageMock,
  });

  try {
    await run();
  } finally {
    if (previousDescriptor) {
      Object.defineProperty(globalThis, "localStorage", previousDescriptor);
    } else {
      delete (globalThis as any).localStorage;
    }
  }
}

test("normalizes saved query result page size", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.pageSize, 100);
  assert.equal(normalizeEditorSettings({ pageSize: 5000 }).pageSize, 5000);
  assert.equal(normalizeEditorSettings({ pageSize: 200000 }).pageSize, 100000);
  assert.equal(normalizeEditorSettings({ pageSize: 0 }).pageSize, 100);
});

test("normalizes the dedicated default row limit for table opens", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.tableOpenPageSize, 100);
  assert.equal(normalizeEditorSettings({ tableOpenPageSize: 1000 }).tableOpenPageSize, 1000);
  assert.equal(normalizeEditorSettings({ tableOpenPageSize: 200000 }).tableOpenPageSize, 100000);
  assert.equal(normalizeEditorSettings({ tableOpenPageSize: 0 }).tableOpenPageSize, 100);
  assert.equal(tableOpenPageLimit(), 100);
  assert.equal(tableOpenPageLimit(1000), 1000);
  assert.equal(tableOpenPageLimit(0), 100);
});

test("migrates legacy execute-all settings to current once and preserves later explicit choices", async () => {
  await withMockLocalStorage({ "dbx-app-state:editor_settings": JSON.stringify({ executeMode: "all" }) }, async () => {
    setActivePinia(createPinia());
    const migratedStore = useSettingsStore();
    await migratedStore.initEditorSettings();

    assert.equal(migratedStore.editorSettings.executeMode, "current");
    let saved = JSON.parse(localStorage.getItem("dbx-app-state:editor_settings") || "{}");
    assert.equal(saved.executeMode, "current");
    assert.equal(saved.executeModeDefaultVersion, EXECUTE_MODE_CURRENT_DEFAULT_VERSION);

    migratedStore.updateEditorSettings({ executeMode: "all" });
    assert.equal(migratedStore.editorSettings.executeMode, "all");
    await vi.waitFor(() => {
      saved = JSON.parse(localStorage.getItem("dbx-app-state:editor_settings") || "{}");
      assert.equal(saved.executeMode, "all");
    });
    assert.equal(saved.executeModeDefaultVersion, EXECUTE_MODE_CURRENT_DEFAULT_VERSION);

    setActivePinia(createPinia());
    const reloadedStore = useSettingsStore();
    await reloadedStore.initEditorSettings();
    assert.equal(reloadedStore.editorSettings.executeMode, "all");
  });
});

test("shows the table-open page size control in the Data settings tab", () => {
  const source = readFileSync("apps/desktop/src/components/editor/EditorSettingsDialog.vue", "utf8");
  const dataSectionStart = source.indexOf("activeSettingsTab === 'data'");
  const nextSectionStart = source.indexOf("activeSettingsTab === 'shortcuts'", dataSectionStart);
  const control = source.indexOf('id="table-open-page-size"');

  assert.ok(dataSectionStart >= 0);
  assert.ok(nextSectionStart > dataSectionStart);
  assert.ok(control > dataSectionStart && control < nextSectionStart);
});

test("defaults export batch size to 2000 rows", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.exportBatchSize, 2000);
  assert.equal(normalizeEditorSettings({}).exportBatchSize, 2000);
  assert.equal(normalizeEditorSettings({ exportBatchSize: 2000 }).exportBatchSize, 2000);
});

test("migrates the legacy saved export batch default to 2000 once", async () => {
  await withMockLocalStorage({ "dbx-editor-settings": JSON.stringify({ exportBatchSize: 10000 }) }, async () => {
    setActivePinia(createPinia());
    const store = useSettingsStore();
    await store.initEditorSettings();

    assert.equal(store.editorSettings.exportBatchSize, 2000);
    assert.equal(localStorage.getItem("dbx-editor-settings"), null);
    assert.equal(JSON.parse(localStorage.getItem("dbx-app-state:editor_settings") || "{}").exportBatchSize, 2000);
  });
});

test("keeps a manually saved 10000 export batch size after migration", async () => {
  await withMockLocalStorage(
    {
      "dbx-editor-settings": JSON.stringify({ exportBatchSize: 10000 }),
      "dbx-export-batch-size-default-migrated-v1": "1",
    },
    async () => {
      setActivePinia(createPinia());
      const store = useSettingsStore();
      await store.initEditorSettings();

      assert.equal(store.editorSettings.exportBatchSize, 10000);
    },
  );
});

test("defaults query-result export row limit settings", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.exportRowLimitEnabled, false);
  assert.equal(DEFAULT_EDITOR_SETTINGS.exportRowLimit, 100000);
  assert.equal(DEFAULT_EDITOR_SETTINGS.queryExportKeysetOptimizationEnabled, true);
  assert.equal(normalizeEditorSettings({}).exportRowLimitEnabled, false);
  assert.equal(normalizeEditorSettings({}).exportRowLimit, 100000);
  assert.equal(normalizeEditorSettings({}).queryExportKeysetOptimizationEnabled, true);
  assert.equal(normalizeEditorSettings({ exportRowLimitEnabled: true }).exportRowLimitEnabled, true);
  assert.equal(normalizeEditorSettings({ exportRowLimitEnabled: "nope" as any }).exportRowLimitEnabled, false);
  assert.equal(normalizeEditorSettings({ exportRowLimit: 250000 }).exportRowLimit, 250000);
  assert.equal(normalizeEditorSettings({ exportRowLimit: 10 }).exportRowLimit, 100000);
  assert.equal(normalizeEditorSettings({ queryExportKeysetOptimizationEnabled: false }).queryExportKeysetOptimizationEnabled, false);
  assert.equal(normalizeEditorSettings({ queryExportKeysetOptimizationEnabled: "nope" as any }).queryExportKeysetOptimizationEnabled, true);
});

test("normalizes editor theme settings", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.theme, "app");
  assert.equal(normalizeEditorSettings({}).theme, "app");
  assert.equal(normalizeEditorSettings({ theme: "app" }).theme, "app");
  assert.equal(normalizeEditorSettings({ theme: "vscode-light" }).theme, "vscode-light");
  assert.equal(normalizeEditorSettings({ theme: "invalid" as any }).theme, DEFAULT_EDITOR_SETTINGS.theme);
});

test("defaults UI font family to the app sans stack", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.uiFontFamily, DEFAULT_UI_FONT_FAMILY);
  assert.equal(normalizeEditorSettings({}).uiFontFamily, DEFAULT_UI_FONT_FAMILY);
  assert.equal(normalizeEditorSettings({ uiFontFamily: "" as any }).uiFontFamily, DEFAULT_UI_FONT_FAMILY);
});

test("keeps saved UI font family", () => {
  const uiFontFamily = `"Aptos", system-ui, sans-serif`;
  assert.equal(normalizeEditorSettings({ uiFontFamily } as any).uiFontFamily, uiFontFamily);
  assert.equal(normalizeEditorSettings({ uiFontFamily: SYSTEM_UI_FONT_FAMILY } as any).uiFontFamily, SYSTEM_UI_FONT_FAMILY);
});

test("defaults dangerous SQL confirmation to enabled", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.confirmDangerousSqlExecution, true);
  assert.equal(normalizeEditorSettings({}).confirmDangerousSqlExecution, true);
  assert.equal(normalizeEditorSettings({ confirmDangerousSqlExecution: false }).confirmDangerousSqlExecution, false);
});

test("defaults statement run buttons to enabled and preserves saved booleans", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.showStatementRunButtons, true);
  assert.equal(normalizeEditorSettings({}).showStatementRunButtons, true);
  assert.equal(normalizeEditorSettings({ showStatementRunButtons: false }).showStatementRunButtons, false);
  assert.equal(normalizeEditorSettings({ showStatementRunButtons: "nope" as any }).showStatementRunButtons, true);
});

test("normalizes SQL snippet enabled state", () => {
  const settings = normalizeEditorSettings({
    snippets: [
      { id: "legacy", label: "legacy", prefix: "leg", body: "SELECT 1;" },
      { id: "disabled", label: "disabled", prefix: "dis", body: "SELECT 2;", enabled: false },
      { id: "invalid", label: "invalid", prefix: "inv", body: "SELECT 3;", enabled: "nope" },
    ],
  } as any);

  assert.deepEqual(settings.snippets, [
    { id: "legacy", label: "legacy", prefix: "leg", body: "SELECT 1;", enabled: true },
    { id: "disabled", label: "disabled", prefix: "dis", body: "SELECT 2;", enabled: false },
    { id: "invalid", label: "invalid", prefix: "inv", body: "SELECT 3;", enabled: true },
  ]);
});

test("defaults unsaved SQL close confirmation to enabled", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.confirmUnsavedSqlClose, true);
  assert.equal(normalizeEditorSettings({}).confirmUnsavedSqlClose, true);
  assert.equal(normalizeEditorSettings({ confirmUnsavedSqlClose: false }).confirmUnsavedSqlClose, false);
});

test("defaults Vim mode to off and preserves saved booleans", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.vimModeEnabled, false);
  assert.equal(normalizeEditorSettings({}).vimModeEnabled, false);
  assert.equal(normalizeEditorSettings({ vimModeEnabled: true }).vimModeEnabled, true);
  assert.equal(normalizeEditorSettings({ vimModeEnabled: "yes" as any }).vimModeEnabled, false);
});

test("defaults auto-close brackets to on and preserves saved booleans", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.autoCloseBrackets, true);
  assert.equal(normalizeEditorSettings({}).autoCloseBrackets, true);
  assert.equal(normalizeEditorSettings({ autoCloseBrackets: false }).autoCloseBrackets, false);
  assert.equal(normalizeEditorSettings({ autoCloseBrackets: "nope" as any }).autoCloseBrackets, true);
});

test("defaults update notifications to enabled", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.updateNotificationsEnabled, true);
  assert.equal(normalizeEditorSettings({}).updateNotificationsEnabled, true);
  assert.equal(normalizeEditorSettings({ updateNotificationsEnabled: false } as any).updateNotificationsEnabled, false);
});

test("defaults sidebar table search to disabled and preserves saved booleans", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.sidebarTableSearchEnabled, false);
  assert.equal(normalizeEditorSettings({}).sidebarTableSearchEnabled, false);
  assert.equal(normalizeEditorSettings({ sidebarTableSearchEnabled: true }).sidebarTableSearchEnabled, true);
  assert.equal(normalizeEditorSettings({ sidebarTableSearchEnabled: false }).sidebarTableSearchEnabled, false);
  assert.equal(normalizeEditorSettings({ sidebarTableSearchEnabled: "yes" as any }).sidebarTableSearchEnabled, false);
});

test("defaults shortcut settings", () => {
  const settings = normalizeEditorSettings({});

  assert.equal(settings.shortcuts.executeSql, "Mod+Enter");
  assert.equal(settings.shortcuts.saveSql, "Mod+S");
  assert.equal(settings.shortcuts.copyCurrentRow, "Mod+D");
  assert.equal(settings.shortcuts.deleteCurrentRow, "Delete");
  assert.equal(settings.shortcuts.newQuery, "Mod+T");
  assert.equal(settings.shortcuts.openSettings, "Mod+,");
  assert.equal(settings.shortcuts.focusSearch, "Mod+F");
  assert.equal(settings.shortcuts.zoomInUi, "Mod+=");
  assert.equal(settings.shortcuts.zoomOutUi, "Mod+-");
  assert.equal(settings.shortcuts.resetUiZoom, "Mod+0");
  assert.equal(settings.shortcuts.refreshData, "F5");
  assert.equal(settings.shortcuts.toggleTranspose, "Tab");
  assert.equal(settings.shortcuts.copySidebarSelection, "Mod+C");
  assert.equal(settings.shortcuts.pasteSidebarSelection, "Mod+V");
  assert.equal(settings.shortcuts.editSidebarConnection, "Mod+E");
});

test("keeps saved shortcut overrides", () => {
  const settings = normalizeEditorSettings({
    shortcuts: {
      executeSql: "Shift+Mod+Enter",
      copyCurrentRow: "Alt+Shift+D",
      deleteCurrentRow: "Backspace",
      newQuery: "Shift+Mod+N",
      openSettings: "Shift+Mod+P",
      zoomInUi: "Alt+Mod+=",
      editSidebarConnection: "Alt+E",
    } as any,
  });

  assert.equal(settings.shortcuts.executeSql, "Shift+Mod+Enter");
  assert.equal(settings.shortcuts.copyCurrentRow, "Alt+Shift+D");
  assert.equal(settings.shortcuts.deleteCurrentRow, "Backspace");
  assert.equal(settings.shortcuts.newQuery, "Shift+Mod+N");
  assert.equal(settings.shortcuts.openSettings, "Shift+Mod+P");
  assert.equal(settings.shortcuts.zoomInUi, "Alt+Mod+=");
  assert.equal(settings.shortcuts.editSidebarConnection, "Alt+E");
  assert.equal(settings.shortcuts.saveSql, "Mod+S");
});

test("defaults sidebar activation to single click", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.sidebarActivation, "single");
  assert.equal(normalizeEditorSettings({}).sidebarActivation, "single");
});

test("defaults active tab sidebar selection to off", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.autoSelectActiveSidebarNode, false);
  assert.equal(normalizeEditorSettings({}).autoSelectActiveSidebarNode, false);
});

test("defaults sidebar horizontal scroll to off", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.sidebarAllowHorizontalScroll, false);
  assert.equal(normalizeEditorSettings({}).sidebarAllowHorizontalScroll, false);
});

test("defaults data grid header display settings", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.showColumnCommentsInHeader, true);
  assert.equal(DEFAULT_EDITOR_SETTINGS.compactColumnHeaderActions, true);
  assert.equal(normalizeEditorSettings({}).showColumnCommentsInHeader, true);
  assert.equal(normalizeEditorSettings({}).compactColumnHeaderActions, true);
});

test("keeps saved data grid header display settings", () => {
  const settings = normalizeEditorSettings({
    showColumnCommentsInHeader: true,
    compactColumnHeaderActions: false,
  } as any);

  assert.equal(settings.showColumnCommentsInHeader, true);
  assert.equal(settings.compactColumnHeaderActions, false);
});

test("normalizes data grid render mode", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.dataGridRenderMode, "canvas");
  assert.equal(normalizeEditorSettings({}).dataGridRenderMode, "canvas");
  assert.equal(normalizeEditorSettings({ dataGridRenderMode: "canvas" as any }).dataGridRenderMode, "canvas");
  assert.equal(normalizeEditorSettings({ dataGridRenderMode: "unknown" as any }).dataGridRenderMode, "canvas");
});

test("normalizes table font size", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.tableFontSize, 13);
  assert.equal(normalizeEditorSettings({}).tableFontSize, 13);
  assert.equal(normalizeEditorSettings({ tableFontSize: 12 }).tableFontSize, 12);
  assert.equal(normalizeEditorSettings({ tableFontSize: 14.6 }).tableFontSize, 15);
  assert.equal(normalizeEditorSettings({ tableFontSize: 8 }).tableFontSize, 8);
  assert.equal(normalizeEditorSettings({ tableFontSize: 20 }).tableFontSize, 16);
  assert.equal(normalizeEditorSettings({ tableFontSize: "large" as any }).tableFontSize, 13);
});

test("normalizes table structure editor density", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.structureEditorDensity, "compact");
  assert.equal(normalizeEditorSettings({}).structureEditorDensity, "compact");
  assert.equal(normalizeEditorSettings({ structureEditorDensity: "standard" }).structureEditorDensity, "standard");
  assert.equal(normalizeEditorSettings({ structureEditorDensity: "comfortable" }).structureEditorDensity, "comfortable");
  assert.equal(normalizeEditorSettings({ structureEditorDensity: "invalid" as any }).structureEditorDensity, "compact");
});

test("normalizes table column template fields", () => {
  assert.deepEqual(DEFAULT_EDITOR_SETTINGS.tableColumnTemplateFields, DEFAULT_TABLE_COLUMN_TEMPLATE_FIELDS);
  assert.deepEqual(DEFAULT_EDITOR_SETTINGS.tableColumnTemplateFields, []);
  assert.deepEqual(normalizeEditorSettings({}).tableColumnTemplateFields, DEFAULT_TABLE_COLUMN_TEMPLATE_FIELDS);
  const normalizedTemplateFields = normalizeEditorSettings({ tableColumnTemplateFields: [" tenant_id | mysql:bigint ", "request_id | mysql:varchar(64)", "TENANT_ID | mysql:bigint", ""] } as any).tableColumnTemplateFields;
  assert.equal(
    normalizedTemplateFields.find((field) => field.startsWith("tenant_id")),
    "tenant_id | mysql:bigint",
  );
  assert.equal(
    normalizedTemplateFields.find((field) => field.startsWith("request_id")),
    "request_id | mysql:varchar(64)",
  );
  assert.deepEqual(normalizeEditorSettings({ tableColumnTemplateFields: [] } as any).tableColumnTemplateFields, DEFAULT_TABLE_COLUMN_TEMPLATE_FIELDS);
});

test("normalizes grid drawer widths", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.tableInfoDrawerWidth, 320);
  assert.equal(DEFAULT_EDITOR_SETTINGS.cellDetailDrawerWidth, 380);
  assert.equal(DEFAULT_EDITOR_SETTINGS.cellDetailPanelLayout, "bottom");
  assert.equal(DEFAULT_EDITOR_SETTINGS.cellDetailJsonFormatted, false);
  assert.equal(normalizeEditorSettings({}).tableInfoDrawerWidth, 320);
  assert.equal(normalizeEditorSettings({}).cellDetailDrawerWidth, 380);
  assert.equal(normalizeEditorSettings({}).cellDetailPanelLayout, "bottom");
  assert.equal(normalizeEditorSettings({}).cellDetailJsonFormatted, false);
  assert.equal(normalizeEditorSettings({ tableInfoDrawerWidth: 200 } as any).tableInfoDrawerWidth, 240);
  assert.equal(normalizeEditorSettings({ cellDetailDrawerWidth: 200 } as any).cellDetailDrawerWidth, 260);
  assert.equal(normalizeEditorSettings({ tableInfoDrawerWidth: 1000 } as any).tableInfoDrawerWidth, 900);
  assert.equal(normalizeEditorSettings({ cellDetailDrawerWidth: 456.7 } as any).cellDetailDrawerWidth, 457);
  assert.equal(normalizeEditorSettings({ cellDetailPanelLayout: "right" } as any).cellDetailPanelLayout, "right");
  assert.equal(normalizeEditorSettings({ cellDetailPanelLayout: "invalid" } as any).cellDetailPanelLayout, "bottom");
  assert.equal(normalizeEditorSettings({ cellDetailJsonFormatted: true } as any).cellDetailJsonFormatted, true);
  assert.equal(normalizeEditorSettings({ cellDetailJsonFormatted: "true" } as any).cellDetailJsonFormatted, false);
});

test("keeps saved active tab sidebar selection", () => {
  assert.equal(normalizeEditorSettings({ autoSelectActiveSidebarNode: true } as any).autoSelectActiveSidebarNode, true);
});

test("keeps saved sidebar horizontal scroll preference", () => {
  assert.equal(normalizeEditorSettings({ sidebarAllowHorizontalScroll: true } as any).sidebarAllowHorizontalScroll, true);
});

test("keeps saved sidebar activation", () => {
  assert.equal(normalizeEditorSettings({ sidebarActivation: "double" } as any).sidebarActivation, "double");
  assert.equal(normalizeEditorSettings({ sidebarActivation: "invalid" } as any).sidebarActivation, "single");
});

test("normalizes saved sidebar hidden table prefixes", () => {
  assert.deepEqual(DEFAULT_EDITOR_SETTINGS.sidebarHiddenTablePrefixes, []);
  assert.deepEqual(normalizeEditorSettings({ sidebarHiddenTablePrefixes: [" app_", "app_", "", "ods."] } as any).sidebarHiddenTablePrefixes, ["app_", "ods."]);
});

test("defaults column formatters to an empty record", () => {
  assert.deepEqual(DEFAULT_EDITOR_SETTINGS.columnFormatters, {});
  assert.deepEqual(normalizeEditorSettings({}).columnFormatters, {});
});

test("normalizes global datetime display and transfer formats", () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.globalDateTimeDisplayFormat, "");
  const settings = normalizeEditorSettings({
    globalDateTimeDisplayFormat: " YYYY/MM/DD HH:mm:ss ",
    globalDateTimeExportFormat: "YYYY-M-D H:m:s",
    globalDateTimeImportFormat: 123,
  } as any);

  assert.equal(settings.globalDateTimeDisplayFormat, "YYYY/MM/DD HH:mm:ss");
  assert.equal(settings.globalDateTimeExportFormat, "YYYY-M-D H:m:s");
  assert.equal(settings.globalDateTimeImportFormat, "");
});

test("keeps only valid saved column formatter configs", () => {
  const settings = normalizeEditorSettings({
    columnFormatters: {
      "conn::db::public::users::created_at": { kind: "datetime", unit: "auto", pattern: "YYYY-MM-DD HH:mm:ss" },
      "conn::db::public::users::bad_date": { kind: "datetime", unit: "bogus" },
      "conn::db::public::users::name": { kind: "mask", prefix: 2, suffix: 2 },
      "conn::db::public::users::payload": { kind: "json-path", path: "$.user.name" },
      "conn::db::public::users::invalid_json": { kind: "json-path", path: "user.name" },
      "conn::db::public::users::status": { kind: "custom-ref", formatterId: "fmt_1" },
    },
    customColumnFormatters: {
      fmt_1: { id: "fmt_1", name: "Status label", template: "status:${value}" },
      fmt_empty_name: { id: "fmt_empty_name", name: "", template: "x:${value}" },
      fmt_empty_template: { id: "fmt_empty_template", name: "Broken", template: "" },
    },
  } as any);

  assert.deepEqual(settings.columnFormatters, {
    "conn::db::public::users::created_at": { kind: "datetime", unit: "auto", pattern: "YYYY-MM-DD HH:mm:ss", timezone: undefined },
    "conn::db::public::users::name": { kind: "mask", prefix: 2, suffix: 2 },
    "conn::db::public::users::payload": { kind: "json-path", path: "$.user.name" },
    "conn::db::public::users::status": { kind: "custom-ref", formatterId: "fmt_1" },
  });
  assert.deepEqual(settings.customColumnFormatters, {
    fmt_1: { id: "fmt_1", name: "Status label", template: "status:${value}" },
  });
});

test("AI provider presets include common hosted and local providers", () => {
  assert.equal(AI_PROVIDER_PRESETS.gemini.endpoint, "https://generativelanguage.googleapis.com");
  assert.equal(AI_PROVIDER_PRESETS.gemini.model, "gemini-1.5-pro");
  assert.equal(AI_PROVIDER_PRESETS.deepseek.endpoint, "https://api.deepseek.com/v1");
  assert.equal(AI_PROVIDER_PRESETS.deepseek.model, "deepseek-v4-flash");
  assert.equal(AI_PROVIDER_PRESETS.qwen.endpoint, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(AI_PROVIDER_PRESETS.ollama.endpoint, "http://localhost:11434/v1");
  assert.equal(AI_PROVIDER_PRESETS.ollama.requiresApiKey, false);
  assert.equal(AI_PROVIDER_PRESETS.claude.authMethod, "api-key");
  assert.equal(AI_PROVIDER_PRESETS.openai.authMethod, "bearer");
  assert.equal(AI_PROVIDER_PRESETS.openai.iconSlug, "openai");
  assert.equal(AI_PROVIDER_PRESETS.deepseek.iconSlug, "deepseek");
  assert.equal(AI_PROVIDER_PRESETS["claude-code-cli"].model, "default");
  assert.equal(AI_PROVIDER_PRESETS["claude-code-cli"].iconSlug, "claudecode");
  assert.equal(AI_PROVIDER_PRESETS["claude-code-cli"].requiresApiKey, false);
  assert.ok(Object.keys(AI_PROVIDER_PRESETS).indexOf("claude-code-cli") < Object.keys(AI_PROVIDER_PRESETS).indexOf("codex-cli"));
});

test("normalizes legacy AI config and fills provider defaults", () => {
  const legacy = normalizeAiConfig({
    provider: "openai",
    apiKey: "key",
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o",
  } as any);

  assert.equal(legacy.apiStyle, "completions");
  assert.equal(legacy.provider, "openai");
  assert.equal(legacy.apiKey, "key");
  assert.equal(legacy.authMethod, "bearer");

  const ollama = normalizeAiConfig({ provider: "ollama" } as any);
  assert.equal(ollama.endpoint, "http://localhost:11434/v1");
  assert.equal(ollama.model, "llama3.1");
  assert.equal(ollama.apiKey, "");
  assert.equal(ollama.authMethod, "bearer");

  const claudeToken = normalizeAiConfig({ provider: "claude", apiKey: "token", authMethod: "bearer" } as any);
  assert.equal(claudeToken.authMethod, "bearer");

  const claudeCode = normalizeAiConfig({
    provider: "claude-code-cli",
    claudeCodeCliPath: " /opt/homebrew/bin/claude ",
    claudeCodeCliEnv: { HTTPS_PROXY: "http://proxy:9800" },
    reasoningLevel: "xhigh",
    models: [
      {
        name: "claude-sonnet-4-6",
        label: "Sonnet 4.6",
        supportedEffortLevels: ["low", "high", "xhigh"],
      },
    ],
  } as any);
  assert.equal(claudeCode.claudeCodeCliPath, "/opt/homebrew/bin/claude");
  assert.deepEqual(claudeCode.claudeCodeCliEnv, { HTTPS_PROXY: "http://proxy:9800" });
  assert.equal(claudeCode.reasoningLevel, "xhigh");
  assert.deepEqual(claudeCode.models, [
    {
      name: "claude-sonnet-4-6",
      label: "Sonnet 4.6",
      supportedEffortLevels: ["low", "high", "xhigh"],
    },
  ]);
  assert.equal(normalizeAiConfig({ provider: "claude-code-cli", reasoningLevel: "max" } as any).reasoningLevel, "max");
  assert.equal(normalizeAiConfig({ provider: "claude-code-cli", reasoningLevel: "future" } as any).reasoningLevel, "default");
});

test("infers legacy AI provider from saved endpoint and model", () => {
  const deepseek = normalizeAiConfig({
    apiKey: "key",
    endpoint: "https://api.deepseek.com/anthropic/v1/messages",
    model: "deepseek-v4-pro",
  } as any);

  assert.equal(deepseek.provider, "deepseek");
  assert.equal(deepseek.endpoint, "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal(deepseek.model, "deepseek-v4-pro");
});

test("normalizeEditorSettings falls back to the default UI scale", () => {
  const settings = normalizeEditorSettings({});

  assert.equal(settings.uiScale, DEFAULT_EDITOR_SETTINGS.uiScale);
});

test("normalizeEditorSettings clamps UI scale into the supported range", () => {
  assert.equal(normalizeEditorSettings({ uiScale: 0.2 }).uiScale, 0.75);
  assert.equal(normalizeEditorSettings({ uiScale: 2.8 }).uiScale, 2);
});

test("normalizeEditorSettings keeps valid UI scales with two-decimal precision", () => {
  assert.equal(normalizeEditorSettings({ uiScale: 1.125 }).uiScale, 1.13);
});

test("defaults SQL formatter settings", () => {
  assert.deepEqual(DEFAULT_EDITOR_SETTINGS.sqlFormatter, DEFAULT_SQL_FORMATTER_SETTINGS);
  assert.deepEqual(normalizeEditorSettings({}).sqlFormatter, DEFAULT_EDITOR_SETTINGS.sqlFormatter);
});

test("normalizes saved SQL formatter settings", () => {
  assert.deepEqual(
    normalizeEditorSettings({
      sqlFormatter: {
        keywordCase: "lower",
        functionCase: "upper",
        dataTypeCase: "upper",
        useTabs: true,
        tabWidth: 4,
        logicalOperatorNewline: "after",
        expressionWidth: 120,
        linesBetweenQueries: 2,
        denseOperators: true,
        newlineBeforeSemicolon: true,
      },
    } as any).sqlFormatter,
    {
      ...DEFAULT_SQL_FORMATTER_SETTINGS,
      keywordCase: "lower",
      functionCase: "upper",
      dataTypeCase: "upper",
      useTabs: true,
      tabWidth: 4,
      logicalOperatorNewline: "after",
      expressionWidth: 120,
      linesBetweenQueries: 2,
      denseOperators: true,
      newlineBeforeSemicolon: true,
    },
  );
});

test("keeps SQL formatter default objects distinct", () => {
  const normalized = normalizeEditorSettings({});

  assert.notEqual(DEFAULT_EDITOR_SETTINGS.sqlFormatter, DEFAULT_SQL_FORMATTER_SETTINGS);
  assert.notEqual(normalized.sqlFormatter, DEFAULT_EDITOR_SETTINGS.sqlFormatter);
  assert.notEqual(normalized.sqlFormatter, DEFAULT_SQL_FORMATTER_SETTINGS);
});

test("does not leak default-loaded SQL formatter mutations into defaults", async () => {
  await withMockLocalStorage({}, async () => {
    setActivePinia(createPinia());
    const store = useSettingsStore();
    const editorDefaultKeywordCase = DEFAULT_EDITOR_SETTINGS.sqlFormatter.keywordCase;
    const formatterDefaultKeywordCase = DEFAULT_SQL_FORMATTER_SETTINGS.keywordCase;

    try {
      store.editorSettings.sqlFormatter.keywordCase = "lower";

      assert.notEqual(store.editorSettings.sqlFormatter, DEFAULT_EDITOR_SETTINGS.sqlFormatter);
      assert.notEqual(store.editorSettings.sqlFormatter, DEFAULT_SQL_FORMATTER_SETTINGS);
      assert.equal(DEFAULT_EDITOR_SETTINGS.sqlFormatter.keywordCase, editorDefaultKeywordCase);
      assert.equal(DEFAULT_SQL_FORMATTER_SETTINGS.keywordCase, formatterDefaultKeywordCase);
    } finally {
      DEFAULT_EDITOR_SETTINGS.sqlFormatter.keywordCase = editorDefaultKeywordCase;
      DEFAULT_SQL_FORMATTER_SETTINGS.keywordCase = formatterDefaultKeywordCase;
    }
  });
});

test("does not leak migrated SQL formatter mutations into defaults", async () => {
  await withMockLocalStorage({ [OLD_FONT_SIZE_KEY]: "18" }, async () => {
    setActivePinia(createPinia());
    const store = useSettingsStore();
    await store.initEditorSettings();
    const editorDefaultKeywordCase = DEFAULT_EDITOR_SETTINGS.sqlFormatter.keywordCase;
    const formatterDefaultKeywordCase = DEFAULT_SQL_FORMATTER_SETTINGS.keywordCase;

    try {
      assert.equal(store.editorSettings.fontSize, 18);
      store.editorSettings.sqlFormatter.keywordCase = "lower";

      assert.notEqual(store.editorSettings.sqlFormatter, DEFAULT_EDITOR_SETTINGS.sqlFormatter);
      assert.notEqual(store.editorSettings.sqlFormatter, DEFAULT_SQL_FORMATTER_SETTINGS);
      assert.equal(DEFAULT_EDITOR_SETTINGS.sqlFormatter.keywordCase, editorDefaultKeywordCase);
      assert.equal(DEFAULT_SQL_FORMATTER_SETTINGS.keywordCase, formatterDefaultKeywordCase);
    } finally {
      DEFAULT_EDITOR_SETTINGS.sqlFormatter.keywordCase = editorDefaultKeywordCase;
      DEFAULT_SQL_FORMATTER_SETTINGS.keywordCase = formatterDefaultKeywordCase;
    }
  });
});
