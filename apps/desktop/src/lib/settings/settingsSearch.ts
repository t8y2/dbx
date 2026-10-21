import { SQL_VARIABLE_SYNTAX_KEYS, SQL_VARIABLE_SYNTAX_TOKENS } from "@/lib/sql/sqlVariableSyntax";
import { APP_CUSTOM_UI_COLOR_DEFS } from "@/lib/app/appTheme";
import { MCP_TOOL_OPTIONS, MCP_EXECUTION_MODE_COLUMNS } from "@/lib/mcp/mcpPolicySelection";

export type SettingsCategory = "editor" | "formatter" | "appearance" | "navigation" | "data" | "backups" | "tunnels" | "shortcuts" | "snippets" | "sync" | "ai" | "mcp" | "updates" | "security" | "about";

const SETTINGS_CATEGORIES: readonly SettingsCategory[] = ["editor", "formatter", "appearance", "navigation", "data", "backups", "tunnels", "shortcuts", "snippets", "sync", "ai", "mcp", "updates", "security", "about"];

/**
 * Maps retired settings tabs to their current home so saved links and external
 * navigation requests continue to open a populated settings page.
 */
export function resolveSettingsCategory(initialTab?: string): SettingsCategory {
  if (initialTab === "sqlFile") return "editor";
  return SETTINGS_CATEGORIES.includes(initialTab as SettingsCategory) ? (initialTab as SettingsCategory) : "appearance";
}

export interface SettingsSearchContext {
  isWeb: boolean;
  hasSqlServerConnection?: boolean;
  sqlServerSpaceConfirmsCompletionEnabled?: boolean;
  visibleCategories: ReadonlySet<SettingsCategory>;
}

export interface SettingsSearchDefinition {
  id: string;
  category: SettingsCategory;
  /** A localized title key, or a literal title for product names such as AI. */
  titleKey?: string;
  title?: string;
  descriptionKey?: string;
  /** Static localized aliases only; never user-supplied configuration values. */
  keywordKeys?: readonly string[];
  /** Literal static product/field names, never configuration values. */
  keywordTexts?: readonly string[];
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
  keywords?: string;
  categoryLabel: string;
  targetId: string;
  shortcutId?: string;
  route?: SettingsSearchRoute;
}

export interface SettingsSearchRoute {
  syncMethodTab?: "webdav" | "snippet" | "local";
  mcpManagementTab?: "access" | "permissions";
  mcpTransportTab?: "stdio" | "http";
  mcpAuthorizationTab?: "overrides" | "connections" | "databases" | "capabilities";
  formatterMode?: "form" | "json";
}

export type Translate = (key: string) => string;

type ToolbarVisibilityItemKey = "immediateSync" | "dataTransfer" | "driverManager" | "pluginCenter" | "sqlFile" | "schemaDiff" | "dataCompare" | "checkUpdates" | "sqlLibrary" | "sqlFileTree" | "history" | "ai" | "theme" | "github" | "alwaysOnTop";

export type ToolbarVisibilityItem = ({ key: ToolbarVisibilityItemKey; titleKey: string; title?: never } | { key: ToolbarVisibilityItemKey; title: string; titleKey?: never }) & {
  /** The matching toolbar button can only exist in the desktop app, so the Web build hides the switch. */
  desktopOnly?: true;
};

/**
 * The toolbar visibility controls and their search entries use this same list.
 * Keeping the labels here prevents a newly added toggle from being absent from
 * settings search.
 */
export const TOOLBAR_VISIBILITY_ITEMS: readonly ToolbarVisibilityItem[] = [
  { key: "dataTransfer", titleKey: "transfer.dataTransfer" },
  { key: "driverManager", titleKey: "toolbar.driverManager" },
  { key: "pluginCenter", titleKey: "toolbar.pluginCenter" },
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
  { key: "alwaysOnTop", titleKey: "toolbar.alwaysOnTop", desktopOnly: true },
  { key: "immediateSync", titleKey: "toolbar.immediateSync" },
];

export function toolbarVisibilityItemLabel(item: ToolbarVisibilityItem, translate: Translate): string {
  return item.titleKey ? translate(item.titleKey) : (item.title ?? "");
}

/** Desktop-only toolbar switches are hidden in the Web build, where the matching button can never render. */
export function visibleToolbarVisibilityItems(items: readonly ToolbarVisibilityItem[], isWeb: boolean): ToolbarVisibilityItem[] {
  return items.filter((item) => !item.desktopOnly || !isWeb);
}

export function createToolbarVisibilitySettingsSearchDefinitions(items: readonly ToolbarVisibilityItem[] = TOOLBAR_VISIBILITY_ITEMS): SettingsSearchDefinition[] {
  return items.map((item) => ({
    id: `appearance-toolbar-${item.key}`,
    category: "appearance",
    ...(item.titleKey ? { titleKey: item.titleKey } : { title: item.title }),
    targetId: "appearance",
    ...(item.desktopOnly ? { visible: desktopOnly } : {}),
  }));
}

const desktopOnly = (context: SettingsSearchContext) => !context.isWeb;
const webOnly = (context: SettingsSearchContext) => context.isWeb;
const sqlServerSpaceCompletionVisible = (context: SettingsSearchContext) => context.hasSqlServerConnection === true || context.sqlServerSpaceConfirmsCompletionEnabled === true;

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
  { id: "editor-execute-mode", category: "editor", titleKey: "settings.executeMode", targetId: "editor", keywordKeys: ["settings.executeModeAll", "settings.executeModeCurrent"] },
  { id: "editor-default-transaction-mode", category: "editor", titleKey: "settings.defaultTransactionMode", descriptionKey: "settings.defaultTransactionModeDescription", targetId: "editor", keywordKeys: ["settings.defaultTransactionModeAuto", "settings.defaultTransactionModeManual"] },
  { id: "editor-execute-all-on-blank-line", category: "editor", titleKey: "settings.executeAllOnBlankLine", descriptionKey: "settings.executeAllOnBlankLineDescription", targetId: "editor" },
  { id: "editor-execution-target", category: "editor", titleKey: "settings.showExecutionTargetPicker", descriptionKey: "settings.showExecutionTargetPickerDescription", targetId: "editor" },
  { id: "editor-run-buttons", category: "editor", titleKey: "settings.showStatementRunButtons", descriptionKey: "settings.showStatementRunButtonsDescription", targetId: "editor" },
  { id: "editor-locate-cursor-on-gutter-execute", category: "editor", titleKey: "settings.locateCursorOnGutterExecute", descriptionKey: "settings.locateCursorOnGutterExecuteDescription", targetId: "editor" },
  { id: "editor-line-numbers", category: "editor", titleKey: "settings.showLineNumbers", descriptionKey: "settings.showLineNumbersDescription", targetId: "editor" },
  { id: "editor-statement-frame", category: "editor", titleKey: "settings.showCurrentStatementFrame", descriptionKey: "settings.showCurrentStatementFrameDescription", targetId: "editor" },
  { id: "editor-value-hints", category: "editor", titleKey: "settings.showInsertValueHints", descriptionKey: "settings.showInsertValueHintsDescription", targetId: "editor" },
  { id: "editor-show-whitespace", category: "editor", titleKey: "settings.showWhitespace", descriptionKey: "settings.showWhitespaceDescription", targetId: "editor" },
  { id: "editor-word-wrap", category: "editor", titleKey: "settings.wordWrap", descriptionKey: "settings.wordWrapDescription", targetId: "editor" },
  { id: "editor-vim", category: "editor", titleKey: "settings.vimMode", descriptionKey: "settings.vimModeDescription", targetId: "editor" },
  { id: "editor-caret-browsing", category: "editor", titleKey: "settings.caretBrowsing", descriptionKey: "settings.caretBrowsingDescription", targetId: "editor" },
  { id: "editor-brackets", category: "editor", titleKey: "settings.autoCloseBrackets", descriptionKey: "settings.autoCloseBracketsDescription", targetId: "editor" },
  { id: "editor-source-paste-restore", category: "editor", titleKey: "settings.restoreSqlFromSourcePaste", descriptionKey: "settings.restoreSqlFromSourcePasteDescription", targetId: "editor" },
  {
    id: "editor-double-click-string",
    category: "editor",
    titleKey: "settings.doubleClickStringSelectionMode",
    descriptionKey: "settings.doubleClickStringSelectionModeDescription",
    targetId: "editor",
    keywordKeys: ["settings.doubleClickStringSelectionModeContent", "settings.doubleClickStringSelectionModeWord"],
  },
  { id: "editor-completion-spacing", category: "editor", titleKey: "settings.insertSpaceAfterCompletion", descriptionKey: "settings.insertSpaceAfterCompletionDescription", targetId: "editor" },
  { id: "editor-sqlserver-space-completion", category: "editor", titleKey: "settings.sqlServerSpaceConfirmsCompletion", descriptionKey: "settings.sqlServerSpaceConfirmsCompletionDescription", targetId: "editor", visible: sqlServerSpaceCompletionVisible },
  { id: "editor-function-completion-include-params", category: "editor", titleKey: "settings.functionCompletionIncludeParams", descriptionKey: "settings.functionCompletionIncludeParamsDescription", targetId: "editor" },
  {
    id: "editor-completion-trigger-mode",
    category: "editor",
    titleKey: "settings.completionTriggerMode",
    descriptionKey: "settings.completionTriggerModeDescription",
    targetId: "editor",
    keywordKeys: ["settings.completionTriggerModeManual", "settings.completionTriggerModeRequirePrefix", "settings.completionTriggerModePositional"],
  },
  {
    id: "editor-table-completion-schema-qualification",
    category: "editor",
    titleKey: "settings.tableCompletionSchemaQualification",
    descriptionKey: "settings.tableCompletionSchemaQualificationDescription",
    targetId: "editor",
    keywordKeys: ["settings.tableCompletionSchemaQualificationNever", "settings.tableCompletionSchemaQualificationCollision", "settings.tableCompletionSchemaQualificationAlways"],
  },
  { id: "editor-auto-alias", category: "editor", titleKey: "settings.autoAliasTables", descriptionKey: "settings.autoAliasTablesDescription", targetId: "editor" },
  { id: "editor-unsaved-close", category: "editor", titleKey: "settings.confirmUnsavedSqlClose", descriptionKey: "settings.confirmUnsavedSqlCloseDescription", targetId: "editor" },
  {
    id: "editor-app-close-unsaved-tabs",
    category: "editor",
    titleKey: "settings.appCloseUnsavedTabsMode",
    descriptionKey: "settings.appCloseUnsavedTabsModeDescription",
    targetId: "editor",
    keywordKeys: ["settings.appCloseUnsavedTabsModeHint", "settings.appCloseUnsavedTabsModePrompt", "settings.appCloseUnsavedTabsModeKeepDrafts"],
  },
  { id: "editor-prefill-query", category: "navigation", titleKey: "settings.prefillNewQueryWithSelect", descriptionKey: "settings.prefillNewQueryWithSelectDescription", targetId: "navigation" },
  { id: "editor-open-query-on-connection", category: "navigation", titleKey: "settings.openQueryOnConnectionOpen", descriptionKey: "settings.openQueryOnConnectionOpenDescription", targetId: "navigation" },
  { id: "editor-generate-sql-include-database", category: "editor", titleKey: "settings.generateSqlIncludeDatabaseName", descriptionKey: "settings.generateSqlIncludeDatabaseNameDescription", targetId: "editor" },
  { id: "editor-generate-sql-quote-identifiers", category: "editor", titleKey: "settings.generateSqlQuoteIdentifiers", descriptionKey: "settings.generateSqlQuoteIdentifiersDescription", targetId: "editor" },
  { id: "editor-format-sql-on-sql-file-save", category: "editor", titleKey: "settings.formatSqlOnSqlFileSave", descriptionKey: "settings.formatSqlOnSqlFileSaveDescription", targetId: "editor" },
  { id: "editor-table-ddl-hover-preview", category: "editor", titleKey: "settings.showTableDdlHoverPreview", descriptionKey: "settings.showTableDdlHoverPreviewDescription", targetId: "editor" },
  {
    id: "editor-table-hover-lookup-mode",
    category: "editor",
    titleKey: "settings.tableHoverLookupMode",
    descriptionKey: "settings.tableHoverLookupModeDescription",
    targetId: "editor",
    keywordKeys: ["settings.tableHoverLookupModeCurrent", "settings.tableHoverLookupModeFallback", "settings.tableHoverLookupModeAlways"],
  },
  { id: "editor-diagnostics", category: "editor", titleKey: "settings.sqlSemanticDiagnosticsEnabled", descriptionKey: "settings.sqlSemanticDiagnosticsEnabledDescription", targetId: "editor" },
  {
    id: "editor-sql-variables",
    category: "editor",
    titleKey: "settings.sqlVariableSyntax",
    descriptionKey: "settings.sqlVariableSyntaxDescription",
    targetId: "editor",
    keywordKeys: SQL_VARIABLE_SYNTAX_KEYS.map((key) => `settings.sqlVariableSyntax_${key}`),
    keywordTexts: SQL_VARIABLE_SYNTAX_KEYS.map((key) => SQL_VARIABLE_SYNTAX_TOKENS[key]),
  },
  {
    id: "editor-saved-sql-target",
    category: "editor",
    titleKey: "settings.savedSqlOpenTarget",
    targetId: "editor",
    keywordKeys: ["settings.savedSqlOpenTargetCurrentDescription", "settings.savedSqlOpenTargetSavedDescription", "settings.savedSqlOpenTargetSaved", "settings.savedSqlOpenTargetCurrent"],
  },
  {
    id: "editor-ai-sql-apply-target",
    category: "editor",
    titleKey: "settings.aiSqlApplyTarget",
    descriptionKey: "settings.aiSqlApplyTargetCurrentDescription",
    targetId: "editor",
    keywordKeys: ["settings.aiSqlApplyTargetFirstDescription", "settings.aiSqlApplyTargetNewDescription", "settings.aiSqlApplyTargetCurrent", "settings.aiSqlApplyTargetFirst", "settings.aiSqlApplyTargetNew"],
  },
  { id: "editor-confirm-dangerous-sql", category: "editor", titleKey: "settings.confirmDangerousSqlExecution", descriptionKey: "settings.confirmDangerousSqlExecutionDescription", targetId: "editor" },
  { id: "editor-continue-batch-on-error", category: "editor", titleKey: "settings.continueOnErrorOnBatch", descriptionKey: "settings.continueOnErrorOnBatchDescription", targetId: "editor" },
  { id: "editor-table-click-navigation", category: "navigation", titleKey: "settings.clickTableNavigationTarget", descriptionKey: "settings.clickTableNavigationTargetDescription", targetId: "navigation" },
  { id: "editor-object-browser-auto-open-detail", category: "navigation", titleKey: "settings.objectBrowserAutoOpenDetailPanel", descriptionKey: "settings.objectBrowserAutoOpenDetailPanelDescription", targetId: "navigation" },
  { id: "formatter", category: "formatter", titleKey: "settings.sqlFormatterTab", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-shortcuts", category: "formatter", titleKey: "settings.sqlFormatterEditorShortcuts", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-keyword-case", category: "formatter", titleKey: "settings.sqlFormatterKeywordCase", targetId: "formatter", route: { formatterMode: "form" }, keywordKeys: ["settings.sqlFormatterCaseUpper", "settings.sqlFormatterCaseLower", "settings.sqlFormatterCasePreserve"] },
  { id: "formatter-function-case", category: "formatter", titleKey: "settings.sqlFormatterFunctionCase", targetId: "formatter", route: { formatterMode: "form" }, keywordKeys: ["settings.sqlFormatterCaseUpper", "settings.sqlFormatterCaseLower", "settings.sqlFormatterCasePreserve"] },
  { id: "formatter-data-type-case", category: "formatter", titleKey: "settings.sqlFormatterDataTypeCase", targetId: "formatter", route: { formatterMode: "form" }, keywordKeys: ["settings.sqlFormatterCaseUpper", "settings.sqlFormatterCaseLower", "settings.sqlFormatterCasePreserve"] },
  { id: "formatter-identifier-case", category: "formatter", titleKey: "settings.sqlFormatterIdentifierCase", targetId: "formatter", route: { formatterMode: "form" }, keywordKeys: ["settings.sqlFormatterCaseUpper", "settings.sqlFormatterCaseLower", "settings.sqlFormatterCasePreserve"] },
  { id: "formatter-indent", category: "formatter", titleKey: "settings.sqlFormatterIndent", targetId: "formatter", route: { formatterMode: "form" }, keywordKeys: ["settings.sqlFormatterIndentSpaces", "settings.sqlFormatterIndentTabs"] },
  { id: "formatter-tab-width", category: "formatter", titleKey: "settings.sqlFormatterTabWidth", targetId: "formatter", route: { formatterMode: "form" } },
  {
    id: "formatter-indent-style",
    category: "formatter",
    titleKey: "settings.sqlFormatterIndentStyle",
    targetId: "formatter",
    route: { formatterMode: "form" },
    keywordKeys: ["settings.sqlFormatterIndentStyleStandard", "settings.sqlFormatterIndentStyleTabularLeft", "settings.sqlFormatterIndentStyleTabularRight"],
  },
  { id: "formatter-layout-style", category: "formatter", titleKey: "settings.sqlFormatterLayoutStyle", targetId: "formatter", route: { formatterMode: "form" }, keywordKeys: ["settings.sqlFormatterLayoutStyleClassic", "settings.sqlFormatterLayoutStyleDbx"] },
  {
    id: "formatter-logical-operator-newline",
    category: "formatter",
    titleKey: "settings.sqlFormatterLogicalOperatorNewline",
    targetId: "formatter",
    route: { formatterMode: "form" },
    keywordKeys: ["settings.sqlFormatterLogicalBefore", "settings.sqlFormatterLogicalAfter", "settings.sqlFormatterLogicalSameLine"],
  },
  { id: "formatter-comma-position", category: "formatter", titleKey: "settings.sqlFormatterCommaPosition", targetId: "formatter", route: { formatterMode: "form" }, keywordKeys: ["settings.sqlFormatterCommaPositionAfter", "settings.sqlFormatterCommaPositionBefore"] },
  { id: "formatter-from-clause-layout", category: "formatter", titleKey: "settings.sqlFormatterFromClauseLayout", targetId: "formatter", route: { formatterMode: "form" }, keywordKeys: ["settings.sqlFormatterFromNewLine", "settings.sqlFormatterFromSameLine"] },
  { id: "formatter-expression-width", category: "formatter", titleKey: "settings.sqlFormatterExpressionWidth", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-lines-between-queries", category: "formatter", titleKey: "settings.sqlFormatterLinesBetweenQueries", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-preserve-empty-lines", category: "formatter", titleKey: "settings.sqlFormatterPreserveEmptyLines", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-dense-operators", category: "formatter", titleKey: "settings.sqlFormatterDenseOperators", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-newline-before-semicolon", category: "formatter", titleKey: "settings.sqlFormatterNewlineBeforeSemicolon", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-param-types", category: "formatter", titleKey: "settings.sqlFormatterParamTypes", targetId: "formatter", route: { formatterMode: "form" } },
  {
    id: "formatter-custom-rules",
    category: "formatter",
    titleKey: "settings.sqlFormatterCustomRules",
    targetId: "formatter",
    route: { formatterMode: "form" },
    keywordKeys: ["inherit", "singleLine", "fit", "vertical", "wrap", "firstItem", "indent", "before", "after", "none", "remove", "single", "preserve"].map((value) => `settings.sqlFormatterRule_${value}`),
  },
  { id: "formatter-list-layout", category: "formatter", titleKey: "settings.sqlFormatterListLayout", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-select-layout", category: "formatter", titleKey: "settings.sqlFormatterSelectListLayout", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-insert-layout", category: "formatter", titleKey: "settings.sqlFormatterInsertListLayout", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-update-layout", category: "formatter", titleKey: "settings.sqlFormatterUpdateListLayout", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-list-alignment", category: "formatter", titleKey: "settings.sqlFormatterListItemAlignment", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-empty-line-mode", category: "formatter", titleKey: "settings.sqlFormatterEmptyLineMode", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-align-select-aliases", category: "formatter", titleKey: "settings.sqlFormatterAlignSelectAliases", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-align-update-assignments", category: "formatter", titleKey: "settings.sqlFormatterAlignUpdateAssignments", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-select-comma-position", category: "formatter", titleKey: "settings.sqlFormatterSelectCommaPosition", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-insert-comma-position", category: "formatter", titleKey: "settings.sqlFormatterInsertCommaPosition", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-update-comma-position", category: "formatter", titleKey: "settings.sqlFormatterUpdateCommaPosition", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-where-logical-newline", category: "formatter", titleKey: "settings.sqlFormatterWhereLogicalOperatorNewline", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-on-logical-newline", category: "formatter", titleKey: "settings.sqlFormatterOnLogicalOperatorNewline", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-expression-logical-newline", category: "formatter", titleKey: "settings.sqlFormatterExpressionLogicalOperatorNewline", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-newline-before-join-on", category: "formatter", titleKey: "settings.sqlFormatterNewlineBeforeJoinOn", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-collapse-short-statements", category: "formatter", titleKey: "settings.sqlFormatterCollapseShortStatements", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "formatter-preview", category: "formatter", titleKey: "settings.sqlFormatterPreview", targetId: "formatter", route: { formatterMode: "form" }, keywordKeys: ["settings.sqlFormatterPreviewDialect", "settings.sqlFormatterPreviewSource"] },
  { id: "appearance-language", category: "appearance", titleKey: "settings.languageTitle", targetId: "appearance" },
  { id: "appearance-theme", category: "appearance", titleKey: "settings.theme", targetId: "appearance" },
  { id: "appearance-color-theme", category: "appearance", titleKey: "settings.colorTheme", targetId: "appearance", keywordKeys: APP_CUSTOM_UI_COLOR_DEFS.map((item) => item.labelKey) },
  { id: "appearance-ui-scale", category: "appearance", titleKey: "settings.uiScale", descriptionKey: "settings.uiScaleDescription", targetId: "appearance" },
  { id: "appearance-ui-font", category: "appearance", titleKey: "settings.uiFontFamily", descriptionKey: "settings.uiFontFamilyDescription", targetId: "appearance" },
  { id: "appearance-grid-font", category: "appearance", titleKey: "settings.dataGridFontFamily", descriptionKey: "settings.dataGridFontFamilyDescription", targetId: "appearance" },
  { id: "appearance-corners", category: "appearance", titleKey: "settings.cornerStyle", targetId: "appearance" },
  {
    id: "appearance-welcome-page",
    category: "appearance",
    titleKey: "settings.welcomePage",
    descriptionKey: "settings.welcomePageDescription",
    targetId: "welcome-page-settings",
    keywordKeys: ["settings.welcomePageIntro", "settings.welcomePageIntroDescription", "settings.welcomePageWorkspace", "settings.welcomePageWorkspaceDescription"],
  },
  { id: "appearance-layout", category: "appearance", titleKey: "settings.appLayout", targetId: "appearance", keywordKeys: ["settings.appLayoutSeparated", "settings.appLayoutClassic", "settings.appLayoutSeparatedDescription", "settings.appLayoutClassicDescription"] },
  { id: "appearance-tab-layout", category: "appearance", titleKey: "settings.tabLayout", targetId: "appearance", keywordKeys: ["settings.tabLayoutScroll", "settings.tabLayoutWrap", "settings.tabLayoutScrollDescription", "settings.tabLayoutWrapDescription"] },
  {
    id: "appearance-tab-max-width",
    category: "appearance",
    titleKey: "settings.tabMaxWidth",
    descriptionKey: "settings.tabMaxWidthDescription",
    targetId: "appearance",
    keywordKeys: ["settings.tabMaxWidthUnlimited", "settings.tabMaxWidthCompact", "settings.tabMaxWidthMedium", "settings.tabMaxWidthStandard", "settings.tabMaxWidthWide"],
  },
  {
    id: "appearance-connection-tab-colors",
    category: "appearance",
    titleKey: "settings.colorizeConnectionTabs",
    descriptionKey: "settings.colorizeConnectionTabsDescription",
    targetId: "appearance",
    keywordKeys: ["settings.colorizeConnectionTabsScope", "settings.colorizeConnectionTabsScopeAll", "settings.colorizeConnectionTabsScopeActive"],
  },
  { id: "appearance-icons", category: "appearance", titleKey: "settings.iconTheme", targetId: "appearance", visible: desktopOnly },
  {
    id: "appearance-web-logo-position",
    category: "appearance",
    titleKey: "settings.webLogoPosition",
    descriptionKey: "settings.webLogoPositionDescription",
    targetId: "appearance-web-logo-position",
    visible: webOnly,
    keywordKeys: ["settings.webLogoPositionLeft", "settings.webLogoPositionRight", "settings.webLogoPositionHidden"],
  },
  { id: "appearance-tray", category: "appearance", titleKey: "settings.showTrayIcon", descriptionKey: "settings.showTrayIconDescription", targetId: "appearance", visible: desktopOnly },
  { id: "appearance-quit", category: "appearance", titleKey: "settings.quitOnClose", descriptionKey: "settings.quitOnCloseDescription", targetId: "appearance", visible: desktopOnly },
  { id: "about-debug-logs", category: "about", titleKey: "settings.debugLoggingEnabled", descriptionKey: "settings.debugLoggingEnabledDescription", targetId: "about", visible: desktopOnly },
  { id: "navigation", category: "navigation", titleKey: "settings.navigationTab", targetId: "navigation" },
  { id: "navigation-sidebar", category: "navigation", titleKey: "settings.sidebarActivation", targetId: "navigation" },
  {
    id: "navigation-routine-source",
    category: "navigation",
    titleKey: "settings.routineSourceOpenMode",
    descriptionKey: "settings.routineSourceOpenModeQueryTabDescription",
    targetId: "navigation",
    keywordKeys: ["settings.routineSourceOpenModeQueryTab", "settings.routineSourceOpenModeDialog", "settings.routineSourceOpenModeDialogDescription"],
  },
  { id: "navigation-reuse-data-tab", category: "navigation", titleKey: "settings.reuseDataTab", descriptionKey: "settings.reuseDataTabDescription", targetId: "navigation" },
  { id: "navigation-open-data-tabs-next-to-active", category: "navigation", titleKey: "settings.openDataTabsNextToActive", descriptionKey: "settings.openDataTabsNextToActiveDescription", targetId: "navigation" },
  { id: "navigation-object-display", category: "navigation", titleKey: "settings.sidebarObjectDisplay", targetId: "navigation" },
  {
    id: "navigation-object-info",
    category: "navigation",
    titleKey: "settings.sidebarObjectInfoMode",
    descriptionKey: "settings.sidebarObjectInfoModeDescription",
    targetId: "navigation",
    keywordKeys: ["settings.sidebarObjectInfoModeCommentInline", "settings.sidebarObjectInfoModeCommentAligned", "settings.sidebarObjectInfoModeCommentRight", "settings.sidebarObjectInfoModeSize", "settings.sidebarObjectInfoModeCommentAndSize", "settings.sidebarObjectInfoModeHidden"],
  },
  { id: "navigation-table-search", category: "navigation", titleKey: "settings.sidebarTableSearchEnabled", descriptionKey: "settings.sidebarTableSearchEnabledDescription", targetId: "navigation" },
  { id: "navigation-search-opened-databases-only", category: "navigation", titleKey: "settings.sidebarSearchOpenedDatabasesOnly", descriptionKey: "settings.sidebarSearchOpenedDatabasesOnlyDescription", targetId: "navigation" },
  { id: "navigation-active-node", category: "navigation", titleKey: "settings.autoSelectActiveSidebarNode", descriptionKey: "settings.autoSelectActiveSidebarNodeDescription", targetId: "navigation" },
  { id: "navigation-sidebar-pin-default-database", category: "navigation", titleKey: "settings.sidebarPinDefaultDatabase", descriptionKey: "settings.sidebarPinDefaultDatabaseDescription", targetId: "navigation" },
  { id: "navigation-browse-objects-on-database-activation", category: "navigation", titleKey: "settings.sidebarBrowseObjectsOnDatabaseActivation", descriptionKey: "settings.sidebarBrowseObjectsOnDatabaseActivationDescription", targetId: "navigation" },
  {
    id: "navigation-tabs-restore",
    category: "navigation",
    titleKey: "settings.openTabsRestoreMode",
    descriptionKey: "settings.openTabsRestoreModeDescription",
    targetId: "navigation",
    keywordKeys: ["settings.openTabsRestoreModeAll", "settings.openTabsRestoreModePinned", "settings.openTabsRestoreModeNone", "settings.openTabsRestoreModeHint"],
  },
  { id: "navigation-sidebar-scroll", category: "navigation", titleKey: "settings.sidebarAllowHorizontalScroll", descriptionKey: "settings.sidebarAllowHorizontalScrollDescription", targetId: "navigation" },
  { id: "navigation-sidebar-tooltips", category: "navigation", titleKey: "settings.sidebarShowTooltips", descriptionKey: "settings.sidebarShowTooltipsDescription", targetId: "navigation" },
  { id: "navigation-sidebar-user-admin", category: "navigation", titleKey: "settings.sidebarShowUserAdmin", descriptionKey: "settings.sidebarShowUserAdminDescription", targetId: "navigation" },
  { id: "navigation-sidebar-indent", category: "navigation", titleKey: "settings.sidebarIndent", descriptionKey: "settings.sidebarIndentDescription", targetId: "navigation" },
  { id: "navigation-sidebar-font-size", category: "navigation", titleKey: "settings.sidebarFontSize", descriptionKey: "settings.sidebarFontSizeDescription", targetId: "navigation" },
  { id: "navigation-sidebar-density", category: "navigation", titleKey: "settings.sidebarDensity", descriptionKey: "settings.sidebarDensityDescription", targetId: "navigation" },
  { id: "navigation-hidden-tables", category: "navigation", titleKey: "settings.sidebarHiddenTablePrefixes", descriptionKey: "settings.sidebarHiddenTablePrefixesDescription", targetId: "navigation" },
  { id: "history-retention", category: "data", titleKey: "settings.historyRetentionLimit", descriptionKey: "settings.historyRetentionDescription", targetId: "history-retention", keywordKeys: ["settings.historyRetentionUnlimited"] },
  { id: "mcp-history-retention", category: "data", titleKey: "settings.mcpHistoryRetentionLimit", descriptionKey: "settings.mcpHistoryRetentionDescription", targetId: "mcp-history-retention", keywordKeys: ["settings.historyRetentionUnlimited", "settings.mcpHistoryCleanup"] },
  { id: "navigation-table-page-size", category: "navigation", titleKey: "settings.sidebarTablePageSize", descriptionKey: "settings.sidebarTablePageSizeDescription", targetId: "navigation" },
  {
    id: "navigation-disconnect-tabs",
    category: "navigation",
    titleKey: "settings.disconnectTabHandlingMode",
    descriptionKey: "settings.disconnectTabHandlingModeDescription",
    targetId: "navigation",
    keywordKeys: ["settings.disconnectTabHandlingModeCloseTabs", "settings.disconnectTabHandlingModeKeepTabsClearResults", "settings.disconnectTabHandlingModeKeepTabsKeepResults"],
  },
  {
    id: "navigation-delete-connection-tabs",
    category: "navigation",
    titleKey: "settings.deleteConnectionTabHandlingMode",
    descriptionKey: "settings.deleteConnectionTabHandlingModeDescription",
    targetId: "navigation",
    keywordKeys: ["settings.deleteConnectionTabHandlingModeCloseTabs", "settings.deleteConnectionTabHandlingModeKeepSqlTabs", "settings.deleteConnectionTabHandlingModeKeepPinnedSqlTabs", "settings.deleteConnectionTabHandlingModeKeepAllTabs"],
  },
  { id: "navigation-remember-connection-database", category: "navigation", titleKey: "settings.rememberConnectionDatabaseOnDelete", descriptionKey: "settings.rememberConnectionDatabaseOnDeleteDescription", targetId: "navigation", keywordKeys: ["settings.rememberConnectionDatabaseOnDeleteHint"] },
  { id: "query-page-size", category: "data", titleKey: "settings.queryPageSize", descriptionKey: "settings.queryPageSizeDescription", targetId: "data" },
  { id: "data-page-size", category: "data", titleKey: "settings.tableOpenPageSize", descriptionKey: "settings.tableOpenPageSizeDescription", targetId: "data" },
  { id: "data-table-open-sort-mode", category: "data", titleKey: "settings.tableOpenSortMode", descriptionKey: "settings.tableOpenSortDescription", targetId: "data", keywordKeys: ["settings.tableSortUnchanged", "settings.tableSortDatabase", "settings.tableSortLocal"] },
  { id: "data-table-database-sort-direction", category: "data", titleKey: "settings.tableDatabaseSortDirection", targetId: "data", keywordKeys: ["settings.tableSortAscending", "settings.tableSortDescending"] },
  { id: "data-table-local-sort-direction", category: "data", titleKey: "settings.tableLocalSortDirection", targetId: "data", keywordKeys: ["settings.tableSortAscending", "settings.tableSortDescending"] },
  { id: "default-auto-keep-results", category: "data", titleKey: "settings.defaultAutoKeepResults", descriptionKey: "settings.defaultAutoKeepResultsDescription", targetId: "default-auto-keep-results" },
  { id: "multi-statement-default-view", category: "data", titleKey: "settings.multiStatementDefaultView", descriptionKey: "settings.multiStatementDefaultViewDescription", targetId: "multi-statement-default-view", keywordKeys: ["tabs.tableData", "tabs.executionSummary"] },
  { id: "default-explain-view", category: "data", titleKey: "settings.defaultExplainView", descriptionKey: "settings.defaultExplainViewDescription", targetId: "default-explain-view", keywordKeys: ["explain.canvas", "explain.tree", "explain.summary", "explain.standardTable", "explain.raw"] },
  { id: "query-result-max-rows", category: "data", titleKey: "settings.queryResultMaxRows", descriptionKey: "settings.queryResultMaxRowsDescription", targetId: "query-result-max-rows", keywordKeys: ["settings.queryResultMaxRowsUnlimitedDescription"] },
  { id: "data-grid-header-comments", category: "data", titleKey: "settings.showColumnCommentsInHeader", descriptionKey: "settings.showColumnCommentsInHeaderDescription", targetId: "data" },
  { id: "data-grid-comment-info-area", category: "data", titleKey: "settings.dataGridColumnCommentsInInfoArea", descriptionKey: "settings.dataGridColumnCommentsInInfoAreaDescription", targetId: "data" },
  { id: "data-grid-header-types", category: "data", titleKey: "settings.showColumnTypesInHeader", descriptionKey: "settings.showColumnTypesInHeaderDescription", targetId: "data" },
  { id: "data-grid-header-tooltips", category: "data", titleKey: "settings.showColumnHeaderTooltips", descriptionKey: "settings.showColumnHeaderTooltipsDescription", targetId: "data" },
  { id: "result-source-database-name", category: "data", titleKey: "settings.showResultSourceDatabase", descriptionKey: "settings.showResultSourceDatabaseDescription", targetId: "data" },
  {
    id: "result-tab-naming-mode",
    category: "data",
    titleKey: "settings.resultTabNamingMode",
    descriptionKey: "settings.resultTabNamingModeDescription",
    targetId: "data",
    keywordKeys: ["settings.resultTabNamingModeSource", "settings.resultTabNamingModeOrdinal", "settings.resultTabNamingModeComment"],
  },
  { id: "result-tab-prefer-comments", category: "data", titleKey: "settings.resultTabPreferComments", descriptionKey: "settings.resultTabPreferCommentsDescription", targetId: "data" },
  { id: "data-grid-transpose-field-metadata", category: "data", titleKey: "settings.dataGridShowTransposeFieldMetadata", descriptionKey: "settings.dataGridShowTransposeFieldMetadataDescription", targetId: "data" },
  { id: "data-grid-transpose-info-column", category: "data", titleKey: "settings.dataGridTransposeMetadataInInfoColumn", descriptionKey: "settings.dataGridTransposeMetadataInInfoColumnDescription", targetId: "data" },
  { id: "data-grid-cell-type-colors", category: "data", titleKey: "settings.colorizeDataGridCellTypes", descriptionKey: "settings.colorizeDataGridCellTypesDescription", targetId: "data" },
  {
    id: "data-grid-type-colors",
    category: "data",
    titleKey: "settings.dataGridTypeColorScheme",
    descriptionKey: "settings.dataGridTypeColorSchemeDescription",
    targetId: "data-grid-type-colors",
    keywordKeys: [
      "settings.dataGridTypeColorInteger",
      "settings.dataGridTypeColorNumeric",
      "settings.dataGridTypeColorString",
      "settings.dataGridTypeColorBoolean",
      "settings.dataGridTypeColorTemporal",
      "settings.dataGridTypeColorStructured",
      "settings.dataGridTypeColorIdentifier",
      "settings.dataGridTypeColorBinary",
      "settings.dataGridTypeColorSpatial",
    ],
  },
  { id: "data-grid-index-indicators", category: "data", titleKey: "settings.showIndexIndicatorsInHeader", descriptionKey: "settings.showIndexIndicatorsInHeaderDescription", targetId: "data" },
  { id: "data-grid-compact-header-actions", category: "data", titleKey: "settings.compactColumnHeaderActions", descriptionKey: "settings.compactColumnHeaderActionsDescription", targetId: "data" },
  { id: "data-grid-auto-total", category: "data", titleKey: "settings.autoCalculateTotalRows", descriptionKey: "settings.autoCalculateTotalRowsDescription", targetId: "data" },
  { id: "data-grid-infinite-scroll", category: "data", titleKey: "settings.infiniteScroll", descriptionKey: "settings.infiniteScrollDescription", targetId: "data" },
  { id: "redis-key-templates", category: "data", titleKey: "settings.redisKeyTemplates", descriptionKey: "settings.redisKeyTemplatesDescription", targetId: "redis-key-templates" },
  { id: "data-grid-auto-transpose", category: "data", titleKey: "settings.dataGridAutoTransposeSingleRow", descriptionKey: "settings.dataGridAutoTransposeSingleRowDescription", targetId: "data" },
  { id: "data-grid-quick-entry", category: "data", titleKey: "settings.dataGridQuickEntry", descriptionKey: "settings.dataGridQuickEntryDescription", targetId: "data" },
  { id: "data-grid-toolbar-layout", category: "data", titleKey: "settings.dataGridToolbarLayout", descriptionKey: "settings.dataGridToolbarLayoutDescription", targetId: "data-grid-toolbar-layout", keywordKeys: ["settings.dataGridToolbarLayoutSplit", "settings.dataGridToolbarLayoutSingle"] },
  {
    id: "data-grid-filter-view",
    category: "data",
    titleKey: "settings.dataGridFilterView",
    descriptionKey: "settings.dataGridFilterViewDescription",
    targetId: "data-grid-filter-view",
    keywordKeys: ["settings.dataGridFilterViewPreview", "grid.filterQuickView", "grid.filterConditionView", "grid.filterTextView", "settings.dataGridKeepFilterEditorExpandedDescription"],
  },
  { id: "data-grid-flattening-multi-line", category: "data", titleKey: "settings.flatteningMultiLineText", descriptionKey: "settings.flatteningMultiLineTextDescription", targetId: "data" },
  { id: "data-grid-show-whitespace", category: "data", titleKey: "settings.dataGridShowWhitespace", descriptionKey: "settings.dataGridShowWhitespaceDescription", targetId: "data" },
  { id: "data-grid-striped-rows", category: "data", titleKey: "settings.dataGridStripedRows", descriptionKey: "settings.dataGridStripedRowsDescription", targetId: "data-grid-striped-rows" },
  { id: "sql-file-editor-max-mb", category: "editor", titleKey: "settings.externalSqlEditorMaxMb", descriptionKey: "settings.externalSqlEditorMaxMbDescription", targetId: "editor-sql-file" },
  { id: "sql-file-web-upload-max-mb", category: "data", titleKey: "settings.webSqlFileUploadMaxMb", descriptionKey: "settings.webSqlFileUploadMaxMbDescription", targetId: "data-sql-file-upload", visible: (context) => context.isWeb },
  { id: "appearance-toolbar", category: "appearance", titleKey: "settings.toolbarTitle", descriptionKey: "settings.toolbarHiddenHint", targetId: "appearance" },
  { id: "appearance-exclusive-sidebar-panels", category: "appearance", titleKey: "settings.exclusiveRightSidebarPanels", descriptionKey: "settings.exclusiveRightSidebarPanelsDescription", targetId: "appearance" },
  ...createToolbarVisibilitySettingsSearchDefinitions(),
  { id: "data-datetime", category: "data", titleKey: "settings.dateTimeSection", targetId: "data" },
  { id: "data-datetime-display-format", category: "data", titleKey: "settings.globalDateTimeDisplayFormat", descriptionKey: "settings.globalDateTimeDisplayFormatDescription", targetId: "data" },
  { id: "data-datetime-export-format", category: "data", titleKey: "settings.globalDateTimeExportFormat", descriptionKey: "settings.globalDateTimeExportFormatDescription", targetId: "data" },
  { id: "data-datetime-import-format", category: "data", titleKey: "settings.globalDateTimeImportFormat", descriptionKey: "settings.globalDateTimeImportFormatDescription", targetId: "data" },
  { id: "data-export", category: "data", titleKey: "settings.exportSection", targetId: "data" },
  { id: "data-export-preferred-path", category: "data", titleKey: "settings.preferredExportPath", descriptionKey: "settings.preferredExportPathDescription", targetId: "data-export-preferred-path" },
  {
    id: "data-export-file-name-source",
    category: "data",
    titleKey: "settings.queryResultExportFileNameSource",
    descriptionKey: "settings.queryResultExportFileNameSourceDescription",
    targetId: "data-export-file-name-source",
    keywordKeys: ["settings.queryResultExportFileNameSourceResultLabel", "settings.queryResultExportFileNameSourceTabTitle"],
  },
  { id: "data-dameng-client-bin-dir", category: "data", titleKey: "settings.damengClientBinDir", descriptionKey: "settings.damengClientBinDirDescription", targetId: "data-dameng-client-bin-dir", visible: desktopOnly },
  { id: "data-export-auto-open-folder", category: "data", titleKey: "settings.autoOpenExportFolder", descriptionKey: "settings.autoOpenExportFolderDescription", targetId: "data-export-auto-open-folder", visible: desktopOnly },
  { id: "data-export-apply-column-formatters", category: "data", titleKey: "settings.applyColumnFormattersOnExport", descriptionKey: "settings.applyColumnFormattersOnExportDescription", targetId: "data-export-apply-column-formatters" },
  { id: "data-export-batch", category: "data", titleKey: "settings.exportBatchSize", descriptionKey: "settings.exportBatchSizeDescription", targetId: "data" },
  { id: "data-export-row-limit-enabled", category: "data", titleKey: "settings.exportRowLimitEnabled", descriptionKey: "settings.exportRowLimitEnabledDescription", targetId: "data" },
  { id: "data-export-row-limit", category: "data", titleKey: "settings.exportRowLimit", descriptionKey: "settings.exportRowLimitDescription", targetId: "data", keywordKeys: ["settings.exportRowLimitUnlimited"] },
  { id: "data-export-keyset", category: "data", titleKey: "settings.queryExportKeysetOptimizationEnabled", descriptionKey: "settings.queryExportKeysetOptimizationEnabledDescription", targetId: "data" },
  { id: "data-performance", category: "data", titleKey: "settings.performanceSection", targetId: "data-performance" },
  { id: "data-metadata-cache", category: "data", titleKey: "settings.metadataCacheMemoryLimit", descriptionKey: "settings.metadataCacheMemoryLimitDescription", targetId: "data-performance" },
  {
    id: "data-table-template",
    category: "data",
    titleKey: "settings.tableColumnTemplateFields",
    descriptionKey: "settings.tableColumnTemplateFieldsDescription",
    targetId: "table-column-templates",
    keywordKeys: ["settings.tableColumnTemplateColumn", "settings.tableColumnTemplateType", "settings.tableColumnTemplateLength", "settings.tableColumnTemplateDefault", "settings.tableColumnTemplateRequired", "settings.tableColumnTemplateComment"],
  },
  { id: "data-duckdb", category: "data", titleKey: "settings.duckDbWorkerProcessIsolation", descriptionKey: "settings.duckDbWorkerProcessIsolationDescription", targetId: "data", visible: desktopOnly },
  { id: "data-duckdb-process-limit", category: "data", titleKey: "settings.duckDbWorkerMaxProcesses", descriptionKey: "settings.duckDbWorkerMaxProcessesDescription", targetId: "data", visible: desktopOnly },
  {
    id: "backups",
    category: "backups",
    titleKey: "databaseBackup.title",
    targetId: "backups",
    keywordKeys: [
      "databaseBackup.scheduleName",
      "databaseBackup.frequency",
      "databaseBackup.intervalHours",
      "databaseBackup.time",
      "databaseBackup.weekday",
      "databaseBackup.retention",
      "databaseBackup.keepForever",
      "databaseBackup.timeZone",
      "databaseBackup.enabled",
      "databaseBackup.backupName",
      "databaseBackup.connection",
      "databaseBackup.destination",
      "databaseBackup.outputPathTemplate",
      "databaseBackup.runDirectoryPattern",
      "databaseBackup.fileNamePattern",
      "databaseBackup.compression",
      "databaseBackup.compressionGzip",
      "databaseBackup.databases",
      "databaseBackup.allDatabases",
      "databaseBackup.tableScope",
      "databaseBackup.tablePatterns",
      "databaseBackup.contents",
      "databaseExport.includeStructure",
      "databaseExport.includeData",
      "databaseExport.includeObjects",
      "databaseExport.dropTableIfExists",
      "tableMultiSelect.tables",
    ],
  },
  {
    id: "tunnels",
    category: "tunnels",
    titleKey: "settings.tunnelsTab",
    targetId: "tunnels",
    keywordKeys: [
      "settings.tunnelsProfileName",
      "connection.sshHost",
      "connection.sshUser",
      "connection.sshAuthMethod",
      "connection.sshPassword",
      "connection.sshKeyPath",
      "connection.sshKeyPassphrase",
      "connection.sshAgentSockPath",
      "connection.sshExposeLan",
      "connection.sshConnectTimeout",
      "connection.sshAuthMethodPassword",
      "connection.sshAuthMethodKey",
      "connection.sshAuthMethodKeyPassword",
      "connection.sshUseAgent",
      "connection.sshAuthMethodNone",
      "connection.sshAuthMethodNoneHint",
      "connection.proxyType",
      "connection.proxyHost",
      "connection.proxyUsername",
      "connection.proxyPassword",
      "connection.proxyTestTarget",
      "connection.httpTunnelProtocol",
      "connection.httpTunnelProtocolDbx",
      "connection.httpTunnelProtocolNavicat",
      "connection.httpTunnelUrl",
      "connection.httpTunnelToken",
      "connection.httpTunnelConnectTimeout",
    ],
  },
  { id: "shortcuts", category: "shortcuts", titleKey: "settings.shortcutsTab", targetId: "shortcuts" },
  {
    id: "sql-shortcuts",
    category: "shortcuts",
    titleKey: "settings.sqlShortcutsTitle",
    descriptionKey: "settings.sqlShortcutsDescription",
    targetId: "sql-shortcuts",
    keywordKeys: [
      "settings.sqlShortcutsLabel",
      "settings.sqlShortcutsLimit",
      "settings.sqlShortcutsSql",
      "settings.sqlShortcutsDatabaseTypes",
      "settings.sqlShortcutsDatabaseTypesAll",
      "settings.sqlShortcutsDatabaseTypesSelected",
      "settings.sqlShortcutsDatabaseTypesHint",
      "settings.sqlShortcutsSqlDatabase",
      "settings.sqlShortcutsToggle",
      "settings.sqlShortcutsVariableHint",
      "settings.sqlShortcutsSelectLimitHint",
    ],
  },
  {
    id: "snippets",
    category: "snippets",
    titleKey: "settings.snippetsTab",
    descriptionKey: "settings.snippetsDescription",
    targetId: "snippets",
    keywordKeys: ["settings.snippetsLabel", "settings.snippetsPrefix", "settings.snippetsBody", "settings.snippetsToggle", "settings.snippetsEnabled", "settings.snippetsDisabled", "settings.snippetsPlaceholderHint"],
  },
  {
    id: "snippet-trigger-key",
    category: "snippets",
    titleKey: "settings.snippetTriggerKey",
    descriptionKey: "settings.snippetTriggerKeyDescription",
    targetId: "snippet-trigger-key",
    keywordKeys: ["settings.snippetTriggerKeyTab", "settings.snippetTriggerKeySpace", "settings.snippetTriggerKeyBoth"],
  },
  { id: "sync-webdav", category: "sync", titleKey: "settings.syncWebDavTitle", descriptionKey: "settings.syncWebDavDescription", targetId: "sync-webdav", route: { syncMethodTab: "webdav" } },
  { id: "sync-webdav-endpoint", category: "sync", titleKey: "settings.syncEndpoint", targetId: "sync-webdav", route: { syncMethodTab: "webdav" } },
  { id: "sync-webdav-username", category: "sync", titleKey: "settings.syncUsername", targetId: "sync-webdav", route: { syncMethodTab: "webdav" } },
  { id: "sync-webdav-password", category: "sync", titleKey: "settings.syncPassword", targetId: "sync-webdav", route: { syncMethodTab: "webdav" }, keywordKeys: ["settings.syncSavedPassword", "settings.syncRememberWebDavPasswordDescription"] },
  { id: "sync-webdav-remote-path", category: "sync", titleKey: "settings.syncRemotePath", targetId: "sync-webdav", route: { syncMethodTab: "webdav" }, keywordKeys: ["settings.syncRemotePathDescription"] },
  { id: "sync-webdav-user-agent", category: "sync", titleKey: "settings.syncUserAgent", targetId: "sync-webdav", route: { syncMethodTab: "webdav" }, keywordKeys: ["settings.syncUserAgentDescription"] },
  { id: "sync-webdav-auto-upload", category: "sync", titleKey: "settings.syncAutoUploadInterval", targetId: "sync-webdav", route: { syncMethodTab: "webdav" }, keywordKeys: ["settings.syncAutoUploadMinutes"] },
  { id: "sync-snippet", category: "sync", titleKey: "settings.syncSnippetTitle", descriptionKey: "settings.syncSnippetDescription", targetId: "sync-snippet", route: { syncMethodTab: "snippet" }, visible: desktopOnly },
  { id: "sync-snippet-provider", category: "sync", titleKey: "settings.syncSnippetProvider", targetId: "sync-snippet", route: { syncMethodTab: "snippet" }, visible: desktopOnly, keywordKeys: ["settings.syncSnippetProviderGitee"] },
  { id: "sync-snippet-id", category: "sync", titleKey: "settings.syncSnippetId", targetId: "sync-snippet", route: { syncMethodTab: "snippet" }, visible: desktopOnly },
  { id: "sync-snippet-token", category: "sync", titleKey: "settings.syncSnippetToken", targetId: "sync-snippet", route: { syncMethodTab: "snippet" }, visible: desktopOnly, keywordKeys: ["settings.syncSnippetTokenDescription"] },
  {
    id: "sync-local-backup",
    category: "sync",
    titleKey: "settings.localBackupTitle",
    descriptionKey: "settings.localBackupDescription",
    keywordKeys: ["settings.syncSecretsPassphrase", "settings.localBackupPassphraseDescription"],
    targetId: "sync-local",
    route: { syncMethodTab: "local" },
    visible: desktopOnly,
  },
  { id: "sync-secrets", category: "sync", titleKey: "settings.syncSecrets", targetId: "sync", route: { syncMethodTab: "webdav" } },
  { id: "sync-secrets-passphrase", category: "sync", titleKey: "settings.syncSecretsPassphrase", targetId: "sync", route: { syncMethodTab: "webdav" }, keywordKeys: ["settings.syncSecretsPassphraseDescription"] },
  {
    id: "ai-config",
    category: "ai",
    titleKey: "ai.configList",
    targetId: "ai",
    keywordKeys: [
      "ai.configName",
      "ai.provider",
      "ai.customHeaders",
      "ai.customHeadersHint",
      "ai.cliPath",
      "ai.cliPathHint",
      "ai.openCodeCliVersion",
      "ai.openCodeCliVersionAuto",
      "ai.openCodeCliVersionV1",
      "ai.openCodeCliVersionV2",
      "ai.openCodeCliVersionHint",
      "ai.cliEnv",
      "ai.cliEnvHint",
      "ai.defaultModel",
      "ai.contextWindow",
      "ai.contextWindowHint",
      "ai.maxOutputTokens",
      "ai.maxOutputTokensHint",
      "ai.proxy",
      "ai.proxyEnable",
      "ai.proxyUrl",
      "ai.sslVerification",
      "ai.skipTlsVerify",
      "ai.skipTlsVerifyHint",
    ],
    keywordTexts: ["Authentication", "Endpoint", "API", "Auth Token", "API Key"],
  },
  { id: "ai-conversation-font-family", category: "ai", titleKey: "ai.conversationFontFamily", descriptionKey: "ai.conversationTypographyDescription", targetId: "ai-typography", keywordKeys: ["ai.conversationFontFollowInterface"] },
  { id: "ai-conversation-font-size", category: "ai", titleKey: "ai.conversationFontSize", descriptionKey: "ai.conversationTypographyDescription", targetId: "ai-typography", keywordKeys: ["ai.conversationFontSizeRange"] },
  { id: "ai-prompts", category: "ai", titleKey: "ai.promptTemplates", descriptionKey: "ai.promptTemplatesDescription", targetId: "ai", keywordKeys: ["ai.promptTemplateName", "ai.promptTemplateContent", "ai.promptTemplateNameTooLong", "ai.promptTemplateTooLong"] },
  { id: "ai-default-mode", category: "ai", titleKey: "ai.defaultAiMode", descriptionKey: "ai.defaultAiModeDescription", targetId: "ai", keywordKeys: ["ai.modes.ask", "ai.modes.agent"] },
  { id: "ai-default-auto-routing", category: "ai", titleKey: "ai.defaultAutoRouting", descriptionKey: "ai.defaultAutoRoutingDescription", targetId: "ai" },
  { id: "ai-include-query-result", category: "ai", titleKey: "ai.includeQueryResult", descriptionKey: "ai.includeQueryResultDescription", targetId: "ai" },
  {
    id: "ai-sql-apply-target",
    category: "ai",
    titleKey: "settings.aiSqlApplyTarget",
    descriptionKey: "settings.aiSqlApplyTargetCurrentDescription",
    targetId: "ai",
    keywordKeys: ["settings.aiSqlApplyTargetFirstDescription", "settings.aiSqlApplyTargetNewDescription", "settings.aiSqlApplyTargetCurrent", "settings.aiSqlApplyTargetFirst", "settings.aiSqlApplyTargetNew"],
  },
  { id: "ai-agent-turn-limit", category: "ai", titleKey: "ai.maxAgentTurns", descriptionKey: "ai.maxAgentTurnsDescription", targetId: "ai", keywordKeys: ["ai.maxAgentTurnsRange"] },
  { id: "ai-global-retries", category: "ai", titleKey: "ai.maxRetriesGlobal", descriptionKey: "ai.maxRetriesGlobalDescription", targetId: "ai", keywordKeys: ["ai.maxRetriesRange"] },
  { id: "ai-global-instructions", category: "ai", titleKey: "ai.globalInstructions", descriptionKey: "ai.globalInstructionsDescription", targetId: "ai" },
  { id: "ai-custom-skill-root", category: "ai", titleKey: "settings.aiSkillRoot", descriptionKey: "settings.aiSkillRootDesc", targetId: "ai", visible: desktopOnly },
  { id: "ai-skill-auto-enabled", category: "ai", titleKey: "settings.aiSkillAutoEnabled", descriptionKey: "settings.aiSkillAutoEnabledDesc", targetId: "ai", visible: desktopOnly },
  { id: "mcp", category: "mcp", titleKey: "settings.mcpTitle", descriptionKey: "settings.mcpDescription", targetId: "mcp" },
  { id: "mcp-bin-path", category: "mcp", titleKey: "settings.mcpBinPath", targetId: "mcp-stdio", route: { mcpManagementTab: "access", mcpTransportTab: "stdio" } },
  {
    id: "mcp-permissions",
    category: "mcp",
    titleKey: "settings.mcpExecutionMode",
    descriptionKey: "settings.mcpExecutionModeDescription",
    targetId: "mcp-overrides",
    route: { mcpManagementTab: "permissions", mcpAuthorizationTab: "overrides" },
    keywordKeys: MCP_EXECUTION_MODE_COLUMNS.map((mode) => mode.labelKey),
  },
  { id: "mcp-config", category: "mcp", titleKey: "settings.mcpConfig", targetId: "mcp-client-config", route: { mcpManagementTab: "access", mcpTransportTab: "stdio" } },
  { id: "security", category: "security", titleKey: "settings.securityTab", targetId: "security", visible: webOnly },
  { id: "security-password", category: "security", titleKey: "auth.changePassword", targetId: "security", visible: webOnly, keywordKeys: ["auth.changePasswordDescription", "auth.oldPassword", "auth.newPassword", "auth.confirmPassword"] },
  { id: "about-support", category: "about", titleKey: "settings.supportInfoTitle", descriptionKey: "settings.supportInfoDescription", targetId: "about" },
  { id: "about-transfer", category: "about", titleKey: "settings.settingsTransferTitle", descriptionKey: "settings.settingsTransferDescription", targetId: "about" },
  { id: "updates-app", category: "updates", titleKey: "settings.autoUpdateApp", descriptionKey: "settings.autoUpdateAppDescription", targetId: "updates", keywordKeys: ["settings.autoUpdate"] },
  { id: "updates-drivers", category: "updates", titleKey: "settings.autoUpdateDrivers", descriptionKey: "settings.autoUpdateDriversDescription", targetId: "updates" },
  { id: "updates-jdbc", category: "updates", titleKey: "settings.autoUpdateJdbc", descriptionKey: "settings.autoUpdateJdbcDescription", targetId: "updates" },
  { id: "updates-mcp", category: "updates", titleKey: "settings.autoUpdateMcp", descriptionKey: "settings.autoUpdateMcpDescription", targetId: "updates" },
  { id: "updates-plugins", category: "updates", titleKey: "settings.autoUpdatePlugins", descriptionKey: "settings.autoUpdatePluginsDescription", targetId: "updates" },
  { id: "updates-source", category: "updates", titleKey: "settings.updateDownloadSource", descriptionKey: "settings.updateDownloadSourceDescription", targetId: "updates", keywordKeys: ["settings.updateDownloadSourceOfficial", "settings.updateDownloadSourceCnb"] },
  // Fixed controls added alongside the full template coverage audit.
  { id: "editor-keep-explicit-transaction-in-auto-commit", category: "editor", titleKey: "settings.keepExplicitTransactionInAutoCommit", descriptionKey: "settings.keepExplicitTransactionInAutoCommitDescription", targetId: "editor" },
  { id: "editor-excluded-completion-items", category: "editor", titleKey: "settings.excludedCompletionItems", descriptionKey: "settings.excludedCompletionItemsDescription", targetId: "editor" },
  { id: "editor-select-first-completion-on-open", category: "editor", titleKey: "settings.selectFirstCompletionOnOpen", descriptionKey: "settings.selectFirstCompletionOnOpenDescription", targetId: "editor" },
  { id: "editor-sort-completion-columns-alphabetically", category: "editor", titleKey: "settings.sortCompletionColumnsAlphabetically", descriptionKey: "settings.sortCompletionColumnsAlphabeticallyDescription", targetId: "editor" },
  { id: "editor-ddl-open-mode", category: "editor", titleKey: "settings.ddlOpenMode", descriptionKey: "settings.ddlOpenModeDescription", targetId: "editor", keywordKeys: ["settings.ddlOpenModeDialog", "settings.ddlOpenModeTab"] },
  { id: "editor-regex-max-match-count", category: "editor", titleKey: "settings.regexMaxMatchCount", descriptionKey: "settings.regexMaxMatchCountDescription", targetId: "editor" },
  { id: "editor-sql-variable-substitution-enabled", category: "editor", titleKey: "settings.sqlVariableSubstitutionEnabled", targetId: "editor" },
  {
    id: "editor-custom-theme-configure",
    category: "editor",
    titleKey: "settings.customThemeConfigure",
    targetId: "editor-theme",
    keywordKeys: [
      "settings.customThemeTitle",
      "settings.customThemePreset",
      "settings.customThemeVisualEdit",
      "settings.customThemeJsonConfig",
      "settings.customThemeKeyword",
      "settings.customThemeField",
      "settings.customThemeFunction",
      "settings.customThemeString",
      "settings.customThemeNumber",
      "settings.customThemeComment",
      "settings.customThemeTable",
      "settings.customThemeOperator",
      "settings.customThemeType",
      "settings.customThemeBuiltin",
      "settings.customThemeBackground",
      "settings.customThemeForeground",
      "settings.customThemeActiveLine",
      "settings.customThemeSelection",
      "settings.customThemeCursor",
      "settings.customThemeGutterBackground",
      "settings.customThemeLineNumber",
      "settings.customThemeMatchingBracket",
    ],
  },
  {
    id: "appearance-tab-placement",
    category: "appearance",
    titleKey: "settings.tabPlacement",
    descriptionKey: "settings.tabPlacementDescription",
    targetId: "appearance",
    keywordKeys: ["settings.tabPlacementTop", "settings.tabPlacementBottom", "settings.tabPlacementLeft", "settings.tabPlacementRight"],
  },
  { id: "appearance-tab-group", category: "appearance", titleKey: "settings.tabGroup", targetId: "appearance", keywordKeys: ["settings.tabGroupNone", "settings.tabGroupDatabaseType", "settings.tabGroupDatabase", "settings.tabGroupConnection", "settings.tabGroupSidebar"] },
  { id: "appearance-tab-group-rows", category: "appearance", titleKey: "settings.tabGroupRows", descriptionKey: "settings.tabGroupRowsDescription", targetId: "appearance", keywordKeys: ["settings.tabGroupRowsSingle", "settings.tabGroupRowsTwoRow"] },
  { id: "appearance-tab-sort", category: "appearance", titleKey: "settings.tabSort", targetId: "appearance", keywordKeys: ["settings.tabSortManual", "settings.tabSortCreated", "settings.tabSortTitle"] },
  { id: "appearance-background-image", category: "appearance", titleKey: "settings.backgroundImage", descriptionKey: "settings.backgroundImageDescription", targetId: "appearance", visible: desktopOnly },
  {
    id: "appearance-background-image-display-mode",
    category: "appearance",
    titleKey: "settings.backgroundImageDisplayMode",
    targetId: "appearance",
    visible: desktopOnly,
    keywordKeys: ["settings.backgroundImageModeFill", "settings.backgroundImageModeFit", "settings.backgroundImageModeStretch", "settings.backgroundImageModeTile", "settings.backgroundImageModeCenter"],
  },
  { id: "appearance-background-image-transparency", category: "appearance", titleKey: "settings.backgroundImageTransparency", targetId: "appearance", visible: desktopOnly },
  { id: "appearance-background-image-blur", category: "appearance", titleKey: "settings.backgroundImageBlur", targetId: "appearance", visible: desktopOnly },
  { id: "navigation-auto-reload-restored-data-tabs-on-open", category: "navigation", titleKey: "settings.autoReloadRestoredDataTabsOnOpen", descriptionKey: "settings.autoReloadRestoredDataTabsOnOpenDescription", targetId: "navigation" },
  { id: "navigation-sidebar-copy-table-name-separator", category: "navigation", titleKey: "settings.sidebarCopyTableNameSeparator", descriptionKey: "settings.sidebarCopyTableNameSeparatorDescription", targetId: "navigation" },
  { id: "navigation-sidebar-copy-table-name-include-schema", category: "navigation", titleKey: "settings.sidebarCopyTableNameIncludeSchema", descriptionKey: "settings.sidebarCopyTableNameIncludeSchemaDescription", targetId: "navigation" },
  { id: "data-data-grid-keep-filter-editor-expanded", category: "data", titleKey: "settings.dataGridKeepFilterEditorExpanded", descriptionKey: "settings.dataGridKeepFilterEditorExpandedDescription", targetId: "data-grid-filter-view" },
  { id: "data-pin-result-tab-on-click", category: "data", titleKey: "settings.pinResultTabOnClick", descriptionKey: "settings.pinResultTabOnClickDescription", targetId: "pin-result-tab-on-click" },
  { id: "data-query-result-max-rows-enabled", category: "data", titleKey: "settings.queryResultMaxRowsEnabled", targetId: "query-result-max-rows" },
  { id: "data-data-grid-cell-detail-button-visible", category: "data", titleKey: "settings.dataGridCellDetailButtonVisible", descriptionKey: "settings.dataGridCellDetailButtonVisibleDescription", targetId: "data" },
  { id: "data-data-grid-cell-detail-dialog-default", category: "data", titleKey: "settings.dataGridCellDetailDialogDefault", descriptionKey: "settings.dataGridCellDetailDialogDefaultDescription", targetId: "data" },
  { id: "data-data-grid-crosshair-highlight", category: "data", titleKey: "settings.dataGridCrosshairHighlight", descriptionKey: "settings.dataGridCrosshairHighlightDescription", targetId: "data-grid-crosshair" },
  { id: "data-data-grid-crosshair-row-bg", category: "data", titleKey: "settings.dataGridCrosshairRowBg", targetId: "data-grid-crosshair" },
  { id: "data-data-grid-crosshair-col-bg", category: "data", titleKey: "settings.dataGridCrosshairColBg", targetId: "data-grid-crosshair" },
  { id: "data-data-grid-zebra-row-bg", category: "data", titleKey: "settings.dataGridZebraRowBg", targetId: "data-grid-striped-rows" },
  { id: "data-redis-database-display-limit", category: "data", titleKey: "settings.redisDatabaseDisplayLimit", descriptionKey: "settings.redisDatabaseDisplayLimitDescription", targetId: "data" },
  { id: "data-csv-quote-mode", category: "data", titleKey: "settings.csvQuoteMode", descriptionKey: "settings.csvQuoteModeDescription", targetId: "data", keywordKeys: ["settings.csvQuoteModeAll", "settings.csvQuoteModeNecessary"] },
  { id: "data-csv-null-mode", category: "data", titleKey: "settings.csvNullMode", descriptionKey: "settings.csvNullModeDescription", targetId: "data", keywordKeys: ["settings.csvNullModeMarker", "settings.csvNullModeEmpty"] },
  { id: "formatter-sql-formatter-json-mode", category: "formatter", titleKey: "settings.sqlFormatterJsonMode", targetId: "formatter-json", route: { formatterMode: "json" } },
  { id: "formatter-sql-formatter-advanced-options", category: "formatter", titleKey: "settings.sqlFormatterAdvancedOptions", targetId: "formatter", route: { formatterMode: "form" } },
  { id: "ai-restore-last-conversation", category: "ai", titleKey: "ai.restoreLastConversation", descriptionKey: "ai.restoreLastConversationDescription", targetId: "ai" },
  { id: "sync-sync-remember-web-dav-password", category: "sync", titleKey: "settings.syncRememberWebDavPassword", descriptionKey: "settings.syncRememberWebDavPasswordDescription", targetId: "sync-webdav", route: { syncMethodTab: "webdav" } },
  { id: "sync-sync-auto-upload", category: "sync", titleKey: "settings.syncAutoUpload", descriptionKey: "settings.syncAutoUploadDescription", targetId: "sync-webdav", route: { syncMethodTab: "webdav" }, keywordKeys: ["settings.syncAutoUploadMinutes"] },
  { id: "sync-sync-git-lab-instance", category: "sync", titleKey: "settings.syncGitLabInstance", targetId: "sync-snippet", route: { syncMethodTab: "snippet" }, visible: desktopOnly, keywordKeys: ["settings.syncGitLabHttpWarning"] },
  { id: "sync-sync-snippet-remember-token", category: "sync", titleKey: "settings.syncSnippetRememberToken", targetId: "sync-snippet", route: { syncMethodTab: "snippet" }, visible: desktopOnly, keywordKeys: ["settings.syncSnippetTokenDescription"] },
  {
    id: "sync-sync-snippet-passphrase",
    category: "sync",
    titleKey: "settings.syncSnippetPassphrase",
    descriptionKey: "settings.syncSnippetPassphraseDescription",
    targetId: "sync-snippet",
    route: { syncMethodTab: "snippet" },
    visible: desktopOnly,
    keywordKeys: ["settings.syncSnippetRememberPassphraseDescription"],
  },
  { id: "sync-sync-snippet-remember-passphrase", category: "sync", titleKey: "settings.syncSnippetRememberPassphrase", descriptionKey: "settings.syncSnippetRememberPassphraseDescription", targetId: "sync-snippet", route: { syncMethodTab: "snippet" }, visible: desktopOnly },
  { id: "sync-sync-snippet-auto-upload", category: "sync", titleKey: "settings.syncSnippetAutoUpload", descriptionKey: "settings.syncSnippetAutoUploadDescription", targetId: "sync-snippet", route: { syncMethodTab: "snippet" }, visible: desktopOnly, keywordKeys: ["settings.syncAutoUploadMinutes"] },
  { id: "sync-sync-snippet-auto-upload-interval", category: "sync", titleKey: "settings.syncSnippetAutoUploadInterval", targetId: "sync-snippet", route: { syncMethodTab: "snippet" }, visible: desktopOnly, keywordKeys: ["settings.syncAutoUploadMinutes"] },
  { id: "sync-sync-snippet-include-secrets", category: "sync", titleKey: "settings.syncSnippetIncludeSecrets", targetId: "sync-snippet", route: { syncMethodTab: "snippet" }, visible: desktopOnly },
  { id: "sync-sync-snippet-restore-secrets", category: "sync", titleKey: "settings.syncSnippetRestoreSecrets", targetId: "sync-snippet", route: { syncMethodTab: "snippet" }, visible: desktopOnly },
  { id: "sync-sync-snippet-secrets-passphrase", category: "sync", titleKey: "settings.syncSnippetSecretsPassphrase", descriptionKey: "settings.syncSnippetSecretsPassphraseDescription", targetId: "sync-snippet", route: { syncMethodTab: "snippet" }, visible: desktopOnly },
  { id: "mcp-http-service-title", category: "mcp", titleKey: "settings.mcpHttpServiceTitle", targetId: "mcp-http", route: { mcpManagementTab: "access", mcpTransportTab: "http" }, visible: desktopOnly, keywordKeys: ["settings.mcpHttpServiceDescription"], keywordTexts: ["Bearer Token"] },
  {
    id: "mcp-http-remote-title",
    category: "mcp",
    titleKey: "settings.mcpHttpRemoteTitle",
    targetId: "mcp-http",
    route: { mcpManagementTab: "access", mcpTransportTab: "http" },
    visible: desktopOnly,
    keywordKeys: ["settings.mcpHttpRemoteHintPrefix", "settings.mcpHttpRemoteHintMiddle", "settings.mcpHttpRemoteHintSuffix"],
  },
  { id: "mcp-http-host-label", category: "mcp", titleKey: "settings.mcpHttpHostLabel", targetId: "mcp-http", route: { mcpManagementTab: "access", mcpTransportTab: "http" }, visible: desktopOnly },
  { id: "mcp-http-port-label", category: "mcp", titleKey: "settings.mcpHttpPortLabel", targetId: "mcp-http", route: { mcpManagementTab: "access", mcpTransportTab: "http" }, visible: desktopOnly },
  { id: "mcp-http-path-label", category: "mcp", titleKey: "settings.mcpHttpPathLabel", targetId: "mcp-http", route: { mcpManagementTab: "access", mcpTransportTab: "http" }, visible: desktopOnly },
  {
    id: "mcp-http-web-service-title",
    category: "mcp",
    titleKey: "settings.mcpHttpWebServiceTitle",
    targetId: "mcp-http",
    route: { mcpManagementTab: "access", mcpTransportTab: "http" },
    visible: webOnly,
    keywordKeys: ["settings.mcpHttpWebServiceDescription", "settings.mcpHttpEndpointLabel"],
    keywordTexts: ["Bearer Token"],
  },
  { id: "mcp-http-web-enable-label", category: "mcp", titleKey: "settings.mcpHttpWebEnableLabel", targetId: "mcp-http", route: { mcpManagementTab: "access", mcpTransportTab: "http" }, visible: webOnly },
  { id: "mcp-http-allowed-hosts-label", category: "mcp", titleKey: "settings.mcpHttpAllowedHostsLabel", targetId: "mcp-http", route: { mcpManagementTab: "access", mcpTransportTab: "http" }, keywordKeys: ["settings.mcpHttpHostsHint"] },
  {
    id: "mcp-http-allowed-origins-label",
    category: "mcp",
    titleKey: "settings.mcpHttpAllowedOriginsLabel",
    targetId: "mcp-http",
    route: { mcpManagementTab: "access", mcpTransportTab: "http" },
    keywordKeys: ["settings.mcpHttpWebOriginsHint", "settings.mcpHttpOriginsHintPrefix", "settings.mcpHttpOriginsHintSuffix"],
  },
  { id: "mcp-http-endpoint-label", category: "mcp", titleKey: "settings.mcpHttpEndpointLabel", targetId: "mcp-http", route: { mcpManagementTab: "access", mcpTransportTab: "http" }, visible: desktopOnly },
  { id: "mcp-http-client-config-title", category: "mcp", titleKey: "settings.mcpHttpClientConfigTitle", targetId: "mcp-http", route: { mcpManagementTab: "access", mcpTransportTab: "http" }, visible: desktopOnly },
  { id: "mcp-query-timeout", category: "mcp", titleKey: "settings.mcpQueryTimeout", descriptionKey: "settings.mcpQueryTimeoutDescription", targetId: "mcp-query-timeout", route: { mcpManagementTab: "access" } },
  {
    id: "mcp-prompt-high-risk-sql",
    category: "mcp",
    titleKey: "settings.mcpPromptHighRiskSql",
    targetId: "mcp-overrides",
    route: { mcpManagementTab: "permissions", mcpAuthorizationTab: "overrides" },
    keywordKeys: ["settings.mcpExecutionModeDescription", "settings.mcpPermissionGlobalDefaultHint", "settings.mcpCapabilityTitle", "settings.mcpCapabilityDescription", "settings.mcpCapabilityOperation", "settings.mcpCapabilityAlwaysEnforced"],
  },
  {
    id: "mcp-auth-tab-connections-title",
    category: "mcp",
    titleKey: "settings.mcpAuthTabConnectionsTitle",
    targetId: "mcp-connections",
    route: { mcpManagementTab: "permissions", mcpAuthorizationTab: "connections" },
    keywordKeys: [
      "settings.mcpConnectionPolicyAllowSalesforceDml",
      "settings.mcpConnectionPolicyInherit",
      "settings.mcpConnectionPolicyReadOnly",
      "settings.mcpConnectionPolicySafeWrite",
      "settings.mcpConnectionPolicyHighRiskWrite",
      "settings.mcpResourceScopeTitle",
      "settings.mcpScopeModeAll",
      "settings.mcpResourceScopeModeCustom",
    ],
  },
  {
    id: "mcp-auth-tab-databases-title",
    category: "mcp",
    titleKey: "settings.mcpAuthTabDatabasesTitle",
    targetId: "mcp-databases",
    route: { mcpManagementTab: "permissions", mcpAuthorizationTab: "databases" },
    keywordKeys: [
      "settings.mcpConnectionPolicyInherit",
      "settings.mcpConnectionPolicyReadOnly",
      "settings.mcpConnectionPolicySafeWrite",
      "settings.mcpConnectionPolicyHighRiskWrite",
      "settings.mcpDatabaseScopeTitle",
      "settings.mcpDatabaseScopeDescription",
      "settings.mcpDatabaseScopeAriaLabel",
      "settings.mcpDatabaseScopeAllTitle",
      "settings.mcpDatabaseScopeAllDescription",
      "settings.mcpDatabaseScopeSelectedTitle",
      "settings.mcpDatabaseScopeSelectedDescription",
      "settings.mcpDatabaseScopeNoneTitle",
      "settings.mcpDatabaseScopeNoneDescription",
    ],
  },
  {
    id: "mcp-tool-permissions-title",
    category: "mcp",
    titleKey: "settings.mcpToolPermissionsTitle",
    descriptionKey: "settings.mcpToolPermissionsDescription",
    keywordKeys: ["settings.mcpToolCustomPlaceholder", "settings.mcpToolCustomHint"],
    targetId: "mcp-capabilities",
    route: { mcpManagementTab: "permissions", mcpAuthorizationTab: "capabilities" },
  },
  { id: "mcp-permission-preview-title", category: "mcp", titleKey: "settings.mcpPermissionPreviewTitle", targetId: "mcp-capabilities", route: { mcpManagementTab: "permissions", mcpAuthorizationTab: "capabilities" } },
  { id: "backups-background-worker", category: "backups", titleKey: "databaseBackup.backgroundWorker", targetId: "backups", visible: desktopOnly },
  ...MCP_TOOL_OPTIONS.map((tool): SettingsSearchDefinition => ({ id: `mcp-tool-${tool.name}`, category: "mcp", titleKey: tool.labelKey, targetId: "mcp-capabilities", route: { mcpManagementTab: "permissions", mcpAuthorizationTab: "capabilities" } })),
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
      keywords: [...(definition.keywordKeys?.map(translate) ?? []), ...(definition.keywordTexts ?? [])].join("\n"),
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
  return entries.filter((entry) => `${entry.title}\n${entry.description}\n${entry.categoryLabel}\n${entry.keywords ?? ""}`.toLocaleLowerCase(locale).includes(normalizedQuery)).slice(0, limit);
}
