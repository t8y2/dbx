import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTINGS_SEARCH_DEFINITIONS, TOOLBAR_VISIBILITY_ITEMS, createShortcutSettingsSearchDefinitions, createToolbarVisibilitySettingsSearchDefinitions, resolveSettingsSearchEntries, searchSettings, type SettingsCategory, type SettingsSearchDefinition } from "@/lib/settings/settingsSearch";

const settingsDialogSource = readFileSync(new URL("../../../components/editor/EditorSettingsDialog.vue", import.meta.url), "utf8");

const categoryLabels = {
  editor: "Editor",
  formatter: "SQL Formatter",
  appearance: "Appearance",
  navigation: "Navigation",
  data: "Data",
  backups: "Backups",
  tunnels: "Tunnels",
  shortcuts: "Shortcuts",
  snippets: "Snippets",
  sync: "Sync",
  ai: "AI",
  mcp: "MCP",
  security: "Security",
  about: "About",
} satisfies Record<SettingsCategory, string>;

const translations: Record<string, string> = {
  font: "Editor font",
  fontDescription: "Choose the typeface used by the editor",
  export: "Export options",
  hidden: "Desktop only",
};
const translate = (key: string) => translations[key] ?? key;
const allCategories = new Set(Object.keys(categoryLabels) as SettingsCategory[]);

describe("settings search", () => {
  const definitions: readonly SettingsSearchDefinition[] = [
    { id: "font", category: "editor", titleKey: "font", descriptionKey: "fontDescription" },
    { id: "export", category: "data", titleKey: "export" },
    { id: "desktop", category: "about", titleKey: "hidden", visible: ({ isWeb }) => !isWeb },
  ];

  it("indexes the query editor line-number preference", () => {
    const definition = SETTINGS_SEARCH_DEFINITIONS.find((entry) => entry.id === "editor-line-numbers");
    expect(definition).toEqual({
      id: "editor-line-numbers",
      category: "editor",
      titleKey: "settings.showLineNumbers",
      descriptionKey: "settings.showLineNumbersDescription",
      targetId: "editor",
    });

    const entries = resolveSettingsSearchEntries(
      [definition!],
      { isWeb: false, visibleCategories: new Set<SettingsCategory>(["editor"]) },
      (key) =>
        ({
          "settings.showLineNumbers": "Show line numbers",
          "settings.showLineNumbersDescription": "Show line numbers in the SQL editor gutter",
        })[key] ?? key,
      categoryLabels,
    );

    expect(searchSettings(entries, "line number", "en").map((entry) => entry.id)).toEqual(["editor-line-numbers"]);
  });

  it("does not index connection or query timeout under editor settings", () => {
    expect(SETTINGS_SEARCH_DEFINITIONS.map((definition) => definition.id)).not.toContain("editor-global-connect-timeout");
    expect(SETTINGS_SEARCH_DEFINITIONS.map((definition) => definition.id)).not.toContain("editor-global-query-timeout");
  });

  it("indexes the multi-statement default view and its settings control", () => {
    expect(SETTINGS_SEARCH_DEFINITIONS).toContainEqual({
      id: "multi-statement-default-view",
      category: "data",
      titleKey: "settings.multiStatementDefaultView",
      descriptionKey: "settings.multiStatementDefaultViewDescription",
      targetId: "multi-statement-default-view",
    });
    expect(settingsDialogSource).toContain('data-settings-search-id="multi-statement-default-view"');
    expect(settingsDialogSource).toContain('v-model="editMultiStatementDefaultView"');
  });

  it("matches translated title, description, and category without changing declared order", () => {
    const entries = resolveSettingsSearchEntries(definitions, { isWeb: false, visibleCategories: allCategories }, translate, categoryLabels);
    expect(searchSettings(entries, "TYPEFACE", "en").map((entry) => entry.id)).toEqual(["font"]);
    expect(searchSettings(entries, "data", "en").map((entry) => entry.id)).toEqual(["export"]);
    expect(searchSettings(entries, "font", "en").map((entry) => entry.id)).toEqual(["font"]);
  });

  it("returns no result for empty queries and honours visibility conditions", () => {
    const webEntries = resolveSettingsSearchEntries(definitions, { isWeb: true, visibleCategories: allCategories }, translate, categoryLabels);
    expect(searchSettings(webEntries, "  ", "en")).toEqual([]);
    expect(searchSettings(webEntries, "desktop", "en")).toEqual([]);
  });

  it("exposes WebDAV sync in Web settings without exposing snippet sync", () => {
    const webEntries = resolveSettingsSearchEntries(SETTINGS_SEARCH_DEFINITIONS, { isWeb: true, visibleCategories: new Set<SettingsCategory>(["sync"]) }, translate, categoryLabels);

    expect(webEntries.map((entry) => entry.id)).toEqual(["sync-webdav", "sync-webdav-endpoint", "sync-webdav-username", "sync-webdav-password", "sync-webdav-remote-path", "sync-webdav-auto-upload", "sync-secrets", "sync-secrets-passphrase"]);
    expect(settingsDialogSource).toContain('{ value: "sync", label: t("settings.syncTab") }');
    expect(settingsDialogSource).not.toContain('...(isWeb ? [] : [{ value: "sync"');
    expect(settingsDialogSource).toContain('<TabsList v-if="!isWeb"');
  });

  it("defines the WebDAV Web-runtime notice in every supported locale", () => {
    for (const locale of ["zh-CN", "zh-TW", "en", "es", "it", "ja", "ko", "pt-BR"]) {
      const source = readFileSync(new URL(`../../../i18n/locales/${locale}.ts`, import.meta.url), "utf8");
      expect(source, locale).toContain("syncWebDavWebDescription:");
    }
  });

  it("matches Chinese text as a Unicode substring", () => {
    expect(searchSettings([{ id: "font", category: "editor", title: "界面字体", description: "选择应用字体", categoryLabel: "编辑器", targetId: "editor" }], "字体", "zh-CN").map((entry) => entry.id)).toEqual(["font"]);
  });

  it("filters out unavailable categories and caps results", () => {
    const entries = resolveSettingsSearchEntries(definitions, { isWeb: false, visibleCategories: new Set<SettingsCategory>(["editor", "data"]) }, translate, categoryLabels);
    expect(entries.map((entry) => entry.id)).toEqual(["font", "export"]);
    expect(
      searchSettings(
        Array.from({ length: 10 }, (_, index) => ({ ...entries[0], id: String(index) })),
        "font",
        "en",
      ),
    ).toHaveLength(8);
  });

  it("returns matching categories in the navigation order", () => {
    const entries = resolveSettingsSearchEntries(definitions, { isWeb: false, visibleCategories: new Set<SettingsCategory>(["data", "editor", "about"]) }, translate, categoryLabels);

    expect(entries.map((entry) => entry.id)).toEqual(["export", "font", "desktop"]);
  });

  it("preserves nested settings routes on resolved entries", () => {
    const [entry] = resolveSettingsSearchEntries([{ id: "snippet", category: "sync", title: "GitHub", targetId: "sync-snippet", route: { syncMethodTab: "snippet" } }], { isWeb: false, visibleCategories: new Set<SettingsCategory>(["sync"]) }, translate, categoryLabels);

    expect(entry).toMatchObject({ targetId: "sync-snippet", route: { syncMethodTab: "snippet" } });
  });

  it("uses the open state for result visibility and applies nested routes before revealing targets", () => {
    expect(settingsDialogSource).toContain("const settingsSearchVisible = computed(() => settingsSearchOpen.value && settingsSearchActive.value)");
    expect(settingsDialogSource).toContain('v-if="settingsSearchVisible" id="settings-search-results"');
    expect(settingsDialogSource).toMatch(/function applySettingsSearchRoute[\s\S]*?syncMethodTab\.value = result\.route\.syncMethodTab/);
    expect(settingsDialogSource).toMatch(/async function selectSettingsSearchResult[\s\S]*?applySettingsSearchRoute\(result\)[\s\S]*?revealSettingsSearchTarget/);
  });

  it("derives one search result for every built-in shortcut", () => {
    expect(
      createShortcutSettingsSearchDefinitions([
        { id: "formatSql", labelKey: "settings.shortcutFormatSql" },
        { id: "toggleLineComment", labelKey: "settings.shortcutToggleLineComment" },
      ]),
    ).toEqual([
      { id: "shortcut-formatSql", category: "shortcuts", titleKey: "settings.shortcutFormatSql", targetId: "shortcuts", shortcutId: "formatSql" },
      { id: "shortcut-toggleLineComment", category: "shortcuts", titleKey: "settings.shortcutToggleLineComment", targetId: "shortcuts", shortcutId: "toggleLineComment" },
    ]);
  });

  it("derives a search result for every toolbar visibility control", () => {
    const definitions = createToolbarVisibilitySettingsSearchDefinitions();

    expect(definitions).toHaveLength(TOOLBAR_VISIBILITY_ITEMS.length);
    expect(definitions.map((definition) => definition.id)).toEqual(TOOLBAR_VISIBILITY_ITEMS.map((item) => `appearance-toolbar-${item.key}`));
    expect(definitions).toContainEqual({ id: "appearance-toolbar-dataTransfer", category: "appearance", titleKey: "transfer.dataTransfer", targetId: "appearance" });
    expect(definitions).toContainEqual({ id: "appearance-toolbar-ai", category: "appearance", title: "AI", targetId: "appearance" });
  });

  it("indexes the existing descriptions for fixed appearance controls", () => {
    const descriptionTranslations: Record<string, string> = {
      "settings.uiScale": "Interface scale",
      "settings.uiScaleDescription": "Scale the interface for high-DPI displays",
      "settings.uiFontFamily": "Interface font",
      "settings.uiFontFamilyDescription": "Applies to the toolbar and dialogs",
      "settings.showTrayIcon": "Show tray icon",
      "settings.showTrayIconDescription": "Keep DBX hidden in the background",
    };
    const entries = resolveSettingsSearchEntries(SETTINGS_SEARCH_DEFINITIONS, { isWeb: false, visibleCategories: new Set<SettingsCategory>(["appearance"]) }, (key) => descriptionTranslations[key] ?? key, categoryLabels);

    expect(searchSettings(entries, "high-DPI", "en").map((entry) => entry.id)).toEqual(["appearance-ui-scale"]);
    expect(searchSettings(entries, "toolbar and dialogs", "en").map((entry) => entry.id)).toEqual(["appearance-ui-font"]);
    expect(searchSettings(entries, "hidden in the background", "en").map((entry) => entry.id)).toEqual(["appearance-tray"]);
  });

  it("indexes the metadata cache memory limit under data settings", () => {
    expect(SETTINGS_SEARCH_DEFINITIONS).toContainEqual(
      expect.objectContaining({
        id: "data-performance",
        category: "data",
        titleKey: "settings.performanceSection",
        targetId: "data-performance",
      }),
    );
    expect(SETTINGS_SEARCH_DEFINITIONS).toContainEqual(
      expect.objectContaining({
        id: "data-metadata-cache",
        category: "data",
        titleKey: "settings.metadataCacheMemoryLimit",
        targetId: "data-performance",
      }),
    );
  });

  it("renders the metadata cache memory limit in a performance section after export", () => {
    const exportSectionStart = settingsDialogSource.indexOf('t("settings.exportSection")');
    const performanceSectionStart = settingsDialogSource.indexOf('data-settings-search-id="data-performance"');
    const tableStructureSectionStart = settingsDialogSource.indexOf('t("settings.tableStructureSection")');
    const metadataCacheControl = settingsDialogSource.indexOf('id="metadata-cache-memory-limit"');

    expect(exportSectionStart).toBeGreaterThan(-1);
    expect(performanceSectionStart).toBeGreaterThan(exportSectionStart);
    expect(tableStructureSectionStart).toBeGreaterThan(performanceSectionStart);
    expect(metadataCacheControl).toBeGreaterThan(performanceSectionStart);
    expect(metadataCacheControl).toBeLessThan(tableStructureSectionStart);
  });

  it("defines the performance section title in every supported locale", () => {
    for (const locale of ["zh-CN", "zh-TW", "en", "es", "it", "ja", "ko", "pt-BR"]) {
      const source = readFileSync(new URL(`../../../i18n/locales/${locale}.ts`, import.meta.url), "utf8");
      expect(source, locale).toContain("performanceSection:");
    }
  });

  it("activates result buttons through click for keyboard and assistive technology", () => {
    expect(settingsDialogSource).toMatch(/role="option"[\s\S]*?@mousedown\.prevent[\s\S]*?@click="void selectSettingsSearchResult\(result\)"/);
  });

  it("registers every fixed settings control that needs a dedicated search result", () => {
    const expectedControls: ReadonlyArray<Pick<SettingsSearchDefinition, "titleKey" | "category" | "targetId">> = [
      { titleKey: "settings.savedSqlOpenTarget", category: "editor", targetId: "editor" },
      { titleKey: "settings.confirmDangerousSqlExecution", category: "editor", targetId: "editor" },
      { titleKey: "settings.continueOnErrorOnBatch", category: "editor", targetId: "editor" },
      { titleKey: "settings.dataGridQuickEntry", category: "data", targetId: "data" },
      { titleKey: "settings.dataGridFilterView", category: "data", targetId: "data-grid-filter-view" },
      { titleKey: "settings.colorizeDataGridCellTypes", category: "data", targetId: "data" },
      { titleKey: "transfer.dataTransfer", category: "appearance", targetId: "appearance" },
      { titleKey: "toolbar.driverManager", category: "appearance", targetId: "appearance" },
      { titleKey: "toolbar.theme", category: "appearance", targetId: "appearance" },
      { titleKey: "settings.sidebarObjectInfoMode", category: "navigation", targetId: "navigation" },
      { titleKey: "settings.insertSpaceAfterCompletion", category: "editor", targetId: "editor" },
      { titleKey: "settings.completionTriggerMode", category: "editor", targetId: "editor" },
      { titleKey: "settings.autoAliasTables", category: "editor", targetId: "editor" },
      { titleKey: "settings.clickTableNavigationTarget", category: "navigation", targetId: "navigation" },
      { titleKey: "settings.prefillNewQueryWithSelect", category: "navigation", targetId: "navigation" },
      { titleKey: "settings.generateSqlIncludeDatabaseName", category: "editor", targetId: "editor" },
      { titleKey: "settings.formatSqlOnSqlFileSave", category: "editor", targetId: "editor" },
      { titleKey: "settings.sqlFormatterKeywordCase", category: "formatter", targetId: "formatter" },
      { titleKey: "settings.sqlFormatterFunctionCase", category: "formatter", targetId: "formatter" },
      { titleKey: "settings.sqlFormatterDataTypeCase", category: "formatter", targetId: "formatter" },
      { titleKey: "settings.sqlFormatterIdentifierCase", category: "formatter", targetId: "formatter" },
      { titleKey: "settings.sqlFormatterIndent", category: "formatter", targetId: "formatter" },
      { titleKey: "settings.sqlFormatterTabWidth", category: "formatter", targetId: "formatter" },
      { titleKey: "settings.sqlFormatterIndentStyle", category: "formatter", targetId: "formatter" },
      { titleKey: "settings.sqlFormatterLogicalOperatorNewline", category: "formatter", targetId: "formatter" },
      { titleKey: "settings.sqlFormatterExpressionWidth", category: "formatter", targetId: "formatter" },
      { titleKey: "settings.sqlFormatterLinesBetweenQueries", category: "formatter", targetId: "formatter" },
      { titleKey: "settings.sqlFormatterPreserveEmptyLines", category: "formatter", targetId: "formatter" },
      { titleKey: "settings.sqlFormatterDenseOperators", category: "formatter", targetId: "formatter" },
      { titleKey: "settings.sqlFormatterNewlineBeforeSemicolon", category: "formatter", targetId: "formatter" },
      { titleKey: "settings.sqlFormatterParamTypes", category: "formatter", targetId: "formatter" },
      { titleKey: "settings.routineSourceOpenMode", category: "navigation", targetId: "navigation" },
      { titleKey: "settings.disconnectTabHandlingMode", category: "navigation", targetId: "navigation" },
      { titleKey: "settings.compactColumnHeaderActions", category: "data", targetId: "data" },
      { titleKey: "settings.infiniteScroll", category: "data", targetId: "data" },
      { titleKey: "settings.globalDateTimeDisplayFormat", category: "data", targetId: "data" },
      { titleKey: "settings.globalDateTimeExportFormat", category: "data", targetId: "data" },
      { titleKey: "settings.globalDateTimeImportFormat", category: "data", targetId: "data" },
      { titleKey: "settings.exportRowLimitEnabled", category: "data", targetId: "data" },
      { titleKey: "settings.exportRowLimit", category: "data", targetId: "data" },
      { titleKey: "settings.queryExportKeysetOptimizationEnabled", category: "data", targetId: "data" },
      { titleKey: "ai.defaultAiMode", category: "ai", targetId: "ai" },
      { titleKey: "ai.maxAgentTurns", category: "ai", targetId: "ai" },
      { titleKey: "ai.maxRetriesGlobal", category: "ai", targetId: "ai" },
      { titleKey: "ai.globalInstructions", category: "ai", targetId: "ai" },
    ];

    for (const expectedControl of expectedControls) {
      expect(SETTINGS_SEARCH_DEFINITIONS).toContainEqual(expect.objectContaining(expectedControl));
    }
  });
});
