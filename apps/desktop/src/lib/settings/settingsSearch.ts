export type SettingsCategory = "editor" | "formatter" | "appearance" | "navigation" | "data" | "backups" | "tunnels" | "shortcuts" | "snippets" | "sync" | "ai" | "mcp" | "security" | "about";

export interface SettingsSearchContext {
  isWeb: boolean;
  visibleCategories: ReadonlySet<SettingsCategory>;
}

export interface SettingsSearchDefinition {
  id: string;
  category: SettingsCategory;
  /** A localized title key, or a literal title for product names such as AI. */
  titleKey?: string;
  title?: string;
  descriptionKey?: string;
  /** Identifies a built-in shortcut row so its local filter can be restored on navigation. */
  shortcutId?: string;
  route?: SettingsSearchRoute;
  /** The fixed settings-group anchor; omitted values use the owning tab. */
  targetId?: string;
  visible?: (context: SettingsSearchContext) => boolean;
}

export interface SettingsSearchEntry {
  id: string;
  category: SettingsCategory;
  title: string;
  description: string;
  categoryLabel: string;
  targetId: string;
  shortcutId?: string;
  route?: SettingsSearchRoute;
}

export interface SettingsSearchRoute {
  syncMethodTab?: "webdav" | "snippet";
}

export type Translate = (key: string) => string;

type ToolbarVisibilityItemKey = "dataTransfer" | "driverManager" | "sqlFile" | "schemaDiff" | "dataCompare" | "checkUpdates" | "sqlLibrary" | "sqlFileTree" | "history" | "ai" | "theme" | "github";

export type ToolbarVisibilityItem = { key: ToolbarVisibilityItemKey; titleKey: string; title?: never } | { key: ToolbarVisibilityItemKey; title: string; titleKey?: never };

/**
 * The toolbar visibility controls and their search entries use this same list.
 * Keeping the labels here prevents a newly added toggle from being absent from
 * settings search.
 */
export const TOOLBAR_VISIBILITY_ITEMS: readonly ToolbarVisibilityItem[] = [
  { key: "dataTransfer", titleKey: "transfer.dataTransfer" },
  { key: "driverManager", titleKey: "toolbar.driverManager" },
  { key: "sqlFile", titleKey: "sqlFile.title" },
  { key: "schemaDiff", titleKey: "diff.title" },
  { key: "dataCompare", titleKey: "dataCompare.title" },
  { key: "checkUpdates", titleKey: "updates.check" },
  { key: "sqlLibrary", titleKey: "sqlLibrary.title" },
  { key: "sqlFileTree", titleKey: "sqlFileTree.title" },
  { key: "history", titleKey: "history.title" },
  { key: "ai", title: "AI" },
  { key: "theme", titleKey: "toolbar.theme" },
  { key: "github", title: "GitHub" },
];

export function toolbarVisibilityItemLabel(item: ToolbarVisibilityItem, translate: Translate): string {
  return item.titleKey ? translate(item.titleKey) : (item.title ?? "");
}

export function createToolbarVisibilitySettingsSearchDefinitions(items: readonly ToolbarVisibilityItem[] = TOOLBAR_VISIBILITY_ITEMS): SettingsSearchDefinition[] {
  return items.map((item) => ({
    id: `appearance-toolbar-${item.key}`,
    category: "appearance",
    ...(item.titleKey ? { titleKey: item.titleKey } : { title: item.title }),
    targetId: "appearance",
  }));
}

const desktopOnly = (context: SettingsSearchContext) => !context.isWeb;
const webOnly = (context: SettingsSearchContext) => context.isWeb;

export interface ShortcutSearchDefinitionSource {
  id: string;
  labelKey: string;
}

/**
 * Built-in shortcut definitions are already the canonical list of fixed
 * shortcut settings. Keep their search entries derived from that list so new
 * shortcuts cannot be omitted from global settings search.
 */
export function createShortcutSettingsSearchDefinitions(shortcuts: readonly ShortcutSearchDefinitionSource[]): SettingsSearchDefinition[] {
  return shortcuts.map((shortcut) => ({
    id: `shortcut-${shortcut.id}`,
    category: "shortcuts",
    titleKey: shortcut.labelKey,
    targetId: "shortcuts",
    shortcutId: shortcut.id,
  }));
}

/**
 * Fixed settings groups. Dynamic rows (snippets, prompt templates and provider
 * configurations) deliberately resolve to their management entry instead.
 */
export const SETTINGS_SEARCH_DEFINITIONS: readonly SettingsSearchDefinition[] = [
  { id: "editor-font", category: "editor", titleKey: "settings.fontFamily", targetId: "editor" },
  { id: "editor-theme", category: "editor", titleKey: "settings.theme", targetId: "editor" },
  { id: "editor-font-size", category: "editor", titleKey: "settings.fontSize", targetId: "editor" },
  { id: "editor-execute-mode", category: "editor", titleKey: "settings.executeMode", targetId: "editor" },
  { id: "editor-execute-all-on-blank-line", category: "editor", titleKey: "settings.executeAllOnBlankLine", descriptionKey: "settings.executeAllOnBlankLineDescription", targetId: "editor" },
  { id: "editor-execution-target", category: "editor", titleKey: "settings.showExecutionTargetPicker", descriptionKey: "settings.showExecutionTargetPickerDescription", targetId: "editor" },
  { id: "editor-run-buttons", category: "editor", titleKey: "settings.showStatementRunButtons", descriptionKey: "settings.showStatementRunButtonsDescription", targetId: "editor" },
  { id: "editor-statement-frame", category: "editor", titleKey: "settings.showCurrentStatementFrame", descriptionKey: "settings.showCurrentStatementFrameDescription", targetId: "editor" },
  { id: "editor-value-hints", category: "editor", titleKey: "settings.showInsertValueHints", descriptionKey: "settings.showInsertValueHintsDescription", targetId: "editor" },
  { id: "editor-word-wrap", category: "editor", titleKey: "settings.wordWrap", descriptionKey: "settings.wordWrapDescription", targetId: "editor" },
  { id: "editor-vim", category: "editor", titleKey: "settings.vimMode", descriptionKey: "settings.vimModeDescription", targetId: "editor" },
  { id: "editor-brackets", category: "editor", titleKey: "settings.autoCloseBrackets", descriptionKey: "settings.autoCloseBracketsDescription", targetId: "editor" },
  { id: "editor-completion-spacing", category: "editor", titleKey: "settings.insertSpaceAfterCompletion", descriptionKey: "settings.insertSpaceAfterCompletionDescription", targetId: "editor" },
  { id: "editor-completion-trigger-mode", category: "editor", titleKey: "settings.completionTriggerMode", descriptionKey: "settings.completionTriggerModeDescription", targetId: "editor" },
  { id: "editor-auto-alias", category: "editor", titleKey: "settings.autoAliasTables", descriptionKey: "settings.autoAliasTablesDescription", targetId: "editor" },
  { id: "editor-unsaved-close", category: "editor", titleKey: "settings.confirmUnsavedSqlClose", descriptionKey: "settings.confirmUnsavedSqlCloseDescription", targetId: "editor" },
  { id: "editor-prefill-query", category: "editor", titleKey: "settings.prefillNewQueryWithSelect", descriptionKey: "settings.prefillNewQueryWithSelectDescription", targetId: "editor" },
  { id: "editor-diagnostics", category: "editor", titleKey: "settings.sqlSemanticDiagnosticsEnabled", descriptionKey: "settings.sqlSemanticDiagnosticsEnabledDescription", targetId: "editor" },
  { id: "editor-sql-variables", category: "editor", titleKey: "settings.sqlVariableSyntax", descriptionKey: "settings.sqlVariableSyntaxDescription", targetId: "editor" },
  { id: "editor-saved-sql-target", category: "editor", titleKey: "settings.savedSqlOpenTarget", targetId: "editor" },
  { id: "editor-confirm-dangerous-sql", category: "editor", titleKey: "settings.confirmDangerousSqlExecution", descriptionKey: "settings.confirmDangerousSqlExecutionDescription", targetId: "editor" },
  { id: "editor-continue-batch-on-error", category: "editor", titleKey: "settings.continueOnErrorOnBatch", descriptionKey: "settings.continueOnErrorOnBatchDescription", targetId: "editor" },
  { id: "editor-table-click-navigation", category: "editor", titleKey: "settings.clickTableNavigationTarget", descriptionKey: "settings.clickTableNavigationTargetDescription", targetId: "editor" },
  { id: "formatter", category: "formatter", titleKey: "settings.sqlFormatterTab", targetId: "formatter" },
  { id: "formatter-shortcuts", category: "formatter", titleKey: "settings.sqlFormatterEditorShortcuts", targetId: "formatter" },
  { id: "formatter-keyword-case", category: "formatter", titleKey: "settings.sqlFormatterKeywordCase", targetId: "formatter" },
  { id: "formatter-function-case", category: "formatter", titleKey: "settings.sqlFormatterFunctionCase", targetId: "formatter" },
  { id: "formatter-data-type-case", category: "formatter", titleKey: "settings.sqlFormatterDataTypeCase", targetId: "formatter" },
  { id: "formatter-identifier-case", category: "formatter", titleKey: "settings.sqlFormatterIdentifierCase", targetId: "formatter" },
  { id: "formatter-indent", category: "formatter", titleKey: "settings.sqlFormatterIndent", targetId: "formatter" },
  { id: "formatter-tab-width", category: "formatter", titleKey: "settings.sqlFormatterTabWidth", targetId: "formatter" },
  { id: "formatter-indent-style", category: "formatter", titleKey: "settings.sqlFormatterIndentStyle", targetId: "formatter" },
  { id: "formatter-logical-operator-newline", category: "formatter", titleKey: "settings.sqlFormatterLogicalOperatorNewline", targetId: "formatter" },
  { id: "formatter-from-clause-layout", category: "formatter", titleKey: "settings.sqlFormatterFromClauseLayout", targetId: "formatter" },
  { id: "formatter-expression-width", category: "formatter", titleKey: "settings.sqlFormatterExpressionWidth", targetId: "formatter" },
  { id: "formatter-lines-between-queries", category: "formatter", titleKey: "settings.sqlFormatterLinesBetweenQueries", targetId: "formatter" },
  { id: "formatter-dense-operators", category: "formatter", titleKey: "settings.sqlFormatterDenseOperators", targetId: "formatter" },
  { id: "formatter-newline-before-semicolon", category: "formatter", titleKey: "settings.sqlFormatterNewlineBeforeSemicolon", targetId: "formatter" },
  { id: "formatter-param-types", category: "formatter", titleKey: "settings.sqlFormatterParamTypes", targetId: "formatter" },
  { id: "appearance-language", category: "appearance", titleKey: "settings.languageTitle", targetId: "appearance" },
  { id: "appearance-theme", category: "appearance", titleKey: "settings.theme", targetId: "appearance" },
  { id: "appearance-color-theme", category: "appearance", titleKey: "settings.colorTheme", targetId: "appearance" },
  { id: "appearance-ui-scale", category: "appearance", titleKey: "settings.uiScale", descriptionKey: "settings.uiScaleDescription", targetId: "appearance" },
  { id: "appearance-ui-font", category: "appearance", titleKey: "settings.uiFontFamily", descriptionKey: "settings.uiFontFamilyDescription", targetId: "appearance" },
  { id: "appearance-grid-font", category: "appearance", titleKey: "settings.dataGridFontFamily", descriptionKey: "settings.dataGridFontFamilyDescription", targetId: "appearance" },
  { id: "appearance-corners", category: "appearance", titleKey: "settings.cornerStyle", targetId: "appearance" },
  { id: "appearance-layout", category: "appearance", titleKey: "settings.appLayout", targetId: "appearance" },
  { id: "appearance-tab-layout", category: "appearance", titleKey: "settings.tabLayout", targetId: "appearance" },
  { id: "appearance-icons", category: "appearance", titleKey: "settings.iconTheme", targetId: "appearance", visible: desktopOnly },
  { id: "appearance-tray", category: "appearance", titleKey: "settings.showTrayIcon", descriptionKey: "settings.showTrayIconDescription", targetId: "appearance", visible: desktopOnly },
  { id: "appearance-quit", category: "appearance", titleKey: "settings.quitOnClose", descriptionKey: "settings.quitOnCloseDescription", targetId: "appearance", visible: desktopOnly },
  { id: "appearance-updates", category: "appearance", titleKey: "settings.updateNotificationsEnabled", descriptionKey: "settings.updateNotificationsEnabledDescription", targetId: "appearance" },
  { id: "appearance-debug-logs", category: "appearance", titleKey: "settings.debugLoggingEnabled", descriptionKey: "settings.debugLoggingEnabledDescription", targetId: "appearance", visible: desktopOnly },
  { id: "navigation", category: "navigation", titleKey: "settings.navigationTab", targetId: "navigation" },
  { id: "navigation-sidebar", category: "navigation", titleKey: "settings.sidebarActivation", targetId: "navigation" },
  { id: "navigation-routine-source", category: "navigation", titleKey: "settings.routineSourceOpenMode", descriptionKey: "settings.routineSourceOpenModeDescription", targetId: "navigation" },
  { id: "navigation-reuse-data-tab", category: "navigation", titleKey: "settings.reuseDataTab", descriptionKey: "settings.reuseDataTabDescription", targetId: "navigation" },
  { id: "navigation-object-display", category: "navigation", titleKey: "settings.sidebarObjectDisplay", targetId: "navigation" },
  { id: "navigation-object-info", category: "navigation", titleKey: "settings.sidebarObjectInfoMode", descriptionKey: "settings.sidebarObjectInfoModeDescription", targetId: "navigation" },
  { id: "navigation-table-search", category: "navigation", titleKey: "settings.sidebarTableSearchEnabled", descriptionKey: "settings.sidebarTableSearchEnabledDescription", targetId: "navigation" },
  { id: "navigation-active-node", category: "navigation", titleKey: "settings.autoSelectActiveSidebarNode", descriptionKey: "settings.autoSelectActiveSidebarNodeDescription", targetId: "navigation" },
  { id: "navigation-tabs-restore", category: "navigation", titleKey: "settings.openTabsRestoreMode", descriptionKey: "settings.openTabsRestoreModeDescription", targetId: "navigation" },
  { id: "navigation-sidebar-scroll", category: "navigation", titleKey: "settings.sidebarAllowHorizontalScroll", descriptionKey: "settings.sidebarAllowHorizontalScrollDescription", targetId: "navigation" },
  { id: "navigation-hidden-tables", category: "navigation", titleKey: "settings.sidebarHiddenTablePrefixes", descriptionKey: "settings.sidebarHiddenTablePrefixesDescription", targetId: "navigation" },
  { id: "navigation-table-page-size", category: "navigation", titleKey: "settings.sidebarTablePageSize", descriptionKey: "settings.sidebarTablePageSizeDescription", targetId: "navigation" },
  { id: "navigation-disconnect-tabs", category: "navigation", titleKey: "settings.disconnectTabHandlingMode", descriptionKey: "settings.disconnectTabHandlingModeDescription", targetId: "navigation" },
  { id: "query-page-size", category: "data", titleKey: "settings.queryPageSize", descriptionKey: "settings.queryPageSizeDescription", targetId: "data" },
  { id: "data-page-size", category: "data", titleKey: "settings.tableOpenPageSize", descriptionKey: "settings.tableOpenPageSizeDescription", targetId: "data" },
  { id: "query-result-max-rows", category: "data", titleKey: "settings.queryResultMaxRows", descriptionKey: "settings.queryResultMaxRowsDescription", targetId: "data" },
  { id: "data-grid-header-comments", category: "data", titleKey: "settings.showColumnCommentsInHeader", descriptionKey: "settings.showColumnCommentsInHeaderDescription", targetId: "data" },
  { id: "data-grid-header-types", category: "data", titleKey: "settings.showColumnTypesInHeader", descriptionKey: "settings.showColumnTypesInHeaderDescription", targetId: "data" },
  { id: "data-grid-cell-type-colors", category: "data", titleKey: "settings.colorizeDataGridCellTypes", descriptionKey: "settings.colorizeDataGridCellTypesDescription", targetId: "data" },
  { id: "data-grid-index-indicators", category: "data", titleKey: "settings.showIndexIndicatorsInHeader", descriptionKey: "settings.showIndexIndicatorsInHeaderDescription", targetId: "data" },
  { id: "data-grid-compact-header-actions", category: "data", titleKey: "settings.compactColumnHeaderActions", descriptionKey: "settings.compactColumnHeaderActionsDescription", targetId: "data" },
  { id: "data-grid-auto-total", category: "data", titleKey: "settings.autoCalculateTotalRows", descriptionKey: "settings.autoCalculateTotalRowsDescription", targetId: "data" },
  { id: "data-grid-infinite-scroll", category: "data", titleKey: "settings.infiniteScroll", descriptionKey: "settings.infiniteScrollDescription", targetId: "data" },
  { id: "data-grid-auto-transpose", category: "data", titleKey: "settings.dataGridAutoTransposeSingleRow", descriptionKey: "settings.dataGridAutoTransposeSingleRowDescription", targetId: "data" },
  { id: "data-grid-quick-entry", category: "data", titleKey: "settings.dataGridQuickEntry", descriptionKey: "settings.dataGridQuickEntryDescription", targetId: "data" },
  { id: "data-grid-flattening-multi-line", category: "data", titleKey: "settings.flatteningMultiLineText", descriptionKey: "settings.flatteningMultiLineTextDescription", targetId: "data" },
  { id: "appearance-toolbar", category: "appearance", titleKey: "settings.toolbarTitle", descriptionKey: "settings.toolbarHiddenHint", targetId: "appearance" },
  { id: "appearance-exclusive-sidebar-panels", category: "appearance", titleKey: "settings.exclusiveRightSidebarPanels", descriptionKey: "settings.exclusiveRightSidebarPanelsDescription", targetId: "appearance" },
  ...createToolbarVisibilitySettingsSearchDefinitions(),
  { id: "data-datetime", category: "data", titleKey: "settings.dateTimeSection", targetId: "data" },
  { id: "data-datetime-display-format", category: "data", titleKey: "settings.globalDateTimeDisplayFormat", descriptionKey: "settings.globalDateTimeDisplayFormatDescription", targetId: "data" },
  { id: "data-datetime-export-format", category: "data", titleKey: "settings.globalDateTimeExportFormat", descriptionKey: "settings.globalDateTimeExportFormatDescription", targetId: "data" },
  { id: "data-datetime-import-format", category: "data", titleKey: "settings.globalDateTimeImportFormat", descriptionKey: "settings.globalDateTimeImportFormatDescription", targetId: "data" },
  { id: "data-export", category: "data", titleKey: "settings.exportSection", targetId: "data" },
  { id: "data-export-batch", category: "data", titleKey: "settings.exportBatchSize", descriptionKey: "settings.exportBatchSizeDescription", targetId: "data" },
  { id: "data-export-row-limit-enabled", category: "data", titleKey: "settings.exportRowLimitEnabled", descriptionKey: "settings.exportRowLimitEnabledDescription", targetId: "data" },
  { id: "data-export-row-limit", category: "data", titleKey: "settings.exportRowLimit", descriptionKey: "settings.exportRowLimitDescription", targetId: "data" },
  { id: "data-export-keyset", category: "data", titleKey: "settings.queryExportKeysetOptimizationEnabled", descriptionKey: "settings.queryExportKeysetOptimizationEnabledDescription", targetId: "data" },
  { id: "data-table-template", category: "data", titleKey: "settings.tableColumnTemplateFields", descriptionKey: "settings.tableColumnTemplateFieldsDescription", targetId: "table-column-templates" },
  { id: "data-duckdb", category: "data", titleKey: "settings.duckDbWorkerProcessIsolation", descriptionKey: "settings.duckDbWorkerProcessIsolationDescription", targetId: "data", visible: desktopOnly },
  { id: "data-duckdb-process-limit", category: "data", titleKey: "settings.duckDbWorkerMaxProcesses", descriptionKey: "settings.duckDbWorkerMaxProcessesDescription", targetId: "data", visible: desktopOnly },
  { id: "backups", category: "backups", titleKey: "databaseBackup.title", targetId: "backups", visible: desktopOnly },
  { id: "tunnels", category: "tunnels", titleKey: "settings.tunnelsTab", targetId: "tunnels" },
  { id: "shortcuts", category: "shortcuts", titleKey: "settings.shortcutsTab", targetId: "shortcuts" },
  { id: "snippets", category: "snippets", titleKey: "settings.snippetsTab", descriptionKey: "settings.snippetsDescription", targetId: "snippets" },
  { id: "sync-webdav", category: "sync", titleKey: "settings.syncWebDavTitle", descriptionKey: "settings.syncWebDavDescription", targetId: "sync-webdav", route: { syncMethodTab: "webdav" }, visible: desktopOnly },
  { id: "sync-webdav-endpoint", category: "sync", titleKey: "settings.syncEndpoint", targetId: "sync-webdav", route: { syncMethodTab: "webdav" }, visible: desktopOnly },
  { id: "sync-webdav-username", category: "sync", titleKey: "settings.syncUsername", targetId: "sync-webdav", route: { syncMethodTab: "webdav" }, visible: desktopOnly },
  { id: "sync-webdav-password", category: "sync", titleKey: "settings.syncPassword", targetId: "sync-webdav", route: { syncMethodTab: "webdav" }, visible: desktopOnly },
  { id: "sync-webdav-remote-path", category: "sync", titleKey: "settings.syncRemotePath", targetId: "sync-webdav", route: { syncMethodTab: "webdav" }, visible: desktopOnly },
  { id: "sync-webdav-auto-upload", category: "sync", titleKey: "settings.syncAutoUploadInterval", targetId: "sync-webdav", route: { syncMethodTab: "webdav" }, visible: desktopOnly },
  { id: "sync-snippet", category: "sync", titleKey: "settings.syncSnippetTitle", descriptionKey: "settings.syncSnippetDescription", targetId: "sync-snippet", route: { syncMethodTab: "snippet" }, visible: desktopOnly },
  { id: "sync-snippet-provider", category: "sync", titleKey: "settings.syncSnippetProvider", targetId: "sync-snippet", route: { syncMethodTab: "snippet" }, visible: desktopOnly },
  { id: "sync-snippet-id", category: "sync", titleKey: "settings.syncSnippetId", targetId: "sync-snippet", route: { syncMethodTab: "snippet" }, visible: desktopOnly },
  { id: "sync-snippet-token", category: "sync", titleKey: "settings.syncSnippetToken", targetId: "sync-snippet", route: { syncMethodTab: "snippet" }, visible: desktopOnly },
  { id: "sync-secrets", category: "sync", titleKey: "settings.syncSecrets", targetId: "sync", visible: desktopOnly },
  { id: "sync-secrets-passphrase", category: "sync", titleKey: "settings.syncSecretsPassphrase", targetId: "sync", visible: desktopOnly },
  { id: "ai-config", category: "ai", titleKey: "ai.configList", targetId: "ai" },
  { id: "ai-prompts", category: "ai", titleKey: "ai.promptTemplates", descriptionKey: "ai.promptTemplatesDescription", targetId: "ai" },
  { id: "ai-default-mode", category: "ai", titleKey: "ai.defaultAiMode", descriptionKey: "ai.defaultAiModeDescription", targetId: "ai" },
  { id: "ai-agent-turn-limit", category: "ai", titleKey: "ai.maxAgentTurns", descriptionKey: "ai.maxAgentTurnsDescription", targetId: "ai" },
  { id: "ai-global-retries", category: "ai", titleKey: "ai.maxRetriesGlobal", descriptionKey: "ai.maxRetriesGlobalDescription", targetId: "ai" },
  { id: "ai-global-instructions", category: "ai", titleKey: "ai.globalInstructions", descriptionKey: "ai.globalInstructionsDescription", targetId: "ai" },
  { id: "mcp", category: "mcp", titleKey: "settings.mcpTitle", descriptionKey: "settings.mcpDescription", targetId: "mcp" },
  { id: "mcp-bin-path", category: "mcp", titleKey: "settings.mcpBinPath", targetId: "mcp" },
  { id: "mcp-permissions", category: "mcp", titleKey: "settings.mcpExecutionMode", descriptionKey: "settings.mcpExecutionModeDescription", targetId: "mcp" },
  { id: "mcp-config", category: "mcp", titleKey: "settings.mcpConfig", targetId: "mcp" },
  { id: "security", category: "security", titleKey: "settings.securityTab", targetId: "security", visible: webOnly },
  { id: "security-password", category: "security", titleKey: "auth.changePassword", targetId: "security", visible: webOnly },
  { id: "about-support", category: "about", titleKey: "settings.supportInfoTitle", descriptionKey: "settings.supportInfoDescription", targetId: "about" },
  { id: "about-update", category: "about", titleKey: "settings.updateDownloadSource", descriptionKey: "settings.updateDownloadSourceDescription", targetId: "about" },
];

export function resolveSettingsSearchEntries(definitions: readonly SettingsSearchDefinition[], context: SettingsSearchContext, translate: Translate, categoryLabels: Readonly<Record<SettingsCategory, string>>): SettingsSearchEntry[] {
  const categoryOrder = new Map(Array.from(context.visibleCategories, (category, index) => [category, index]));

  return definitions
    .filter((definition) => context.visibleCategories.has(definition.category) && (definition.visible?.(context) ?? true))
    .map((definition) => ({
      id: definition.id,
      category: definition.category,
      title: definition.titleKey ? translate(definition.titleKey) : (definition.title ?? ""),
      description: definition.descriptionKey ? translate(definition.descriptionKey) : "",
      categoryLabel: categoryLabels[definition.category],
      targetId: definition.targetId ?? definition.category,
      shortcutId: definition.shortcutId,
      route: definition.route,
    }))
    .sort((left, right) => (categoryOrder.get(left.category) ?? Number.MAX_SAFE_INTEGER) - (categoryOrder.get(right.category) ?? Number.MAX_SAFE_INTEGER));
}

export function searchSettings(entries: readonly SettingsSearchEntry[], query: string, locale: string, limit = 8): SettingsSearchEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase(locale);
  if (!normalizedQuery) return [];
  return entries.filter((entry) => `${entry.title}\n${entry.description}\n${entry.categoryLabel}`.toLocaleLowerCase(locale).includes(normalizedQuery)).slice(0, limit);
}
