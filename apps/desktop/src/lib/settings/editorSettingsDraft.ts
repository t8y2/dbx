import type { EditorSettings } from "@/stores/settingsStore";
import { normalizeResultPageSize } from "@/lib/dataGrid/paginationPageSize";
import { normalizeQueryResultMaxRows } from "@/lib/dataGrid/queryResultRowLimit";
import { normalizeCompletionTriggerMode } from "@/lib/sql/sqlCompletionTriggerPolicy";
import { normalizeRedisKeyTemplates } from "@/lib/redis/redisKeyTemplates";

export const EDITOR_SETTINGS_DRAFT_KEYS = [
  "fontFamily",
  "fontSize",
  "tableFontFamily",
  "uiFontFamily",
  "uiScale",
  "theme",
  "customThemes",
  "activeCustomThemeId",
  "executeMode",
  "executeAllOnBlankLine",
  "showExecutionTargetPicker",
  "showStatementRunButtons",
  "showLineNumbers",
  "showCurrentStatementFrame",
  "showInsertValueHints",
  "autoAliasTables",
  "insertSpaceAfterCompletion",
  "sortCompletionColumnsAlphabetically",
  "selectFirstCompletionOnOpen",
  "wordWrap",
  "vimModeEnabled",
  "autoCloseBrackets",
  "sqlSemanticDiagnosticsMode",
  "confirmDangerousSqlExecution",
  "confirmUnsavedSqlClose",
  "appCloseUnsavedTabsMode",
  "savedSqlOpenTargetMode",
  "appLayout",
  "tabLayout",
  "showColumnCommentsInHeader",
  "showColumnTypesInHeader",
  "dataGridShowTransposeFieldMetadata",
  "colorizeDataGridCellTypes",
  "dataGridTypeColorSchemes",
  "activeDataGridTypeColorSchemeId",
  "showIndexIndicatorsInHeader",
  "compactColumnHeaderActions",
  "dataGridQuickEntry",
  "dataGridFilterEditorView",
  "dataGridTextFilterPanelHeight",
  "multiStatementDefaultView",
  "dataGridAutoTransposeSingleRow",
  "dataGridCellDetailButtonVisible",
  "dataGridCrosshairHighlight",
  "pageSize",
  "tableOpenPageSize",
  "queryResultMaxRowsEnabled",
  "queryResultMaxRows",
  "infiniteScroll",
  "regexMaxMatchCount",
  "autoCalculateTotalRows",
  "flatteningMultiLineText",
  "tableColumnTemplateFields",
  "shortcuts",
  "sqlFormatter",
  "sidebarActivation",
  "sidebarObjectDisplay",
  "routineSourceOpenMode",
  "sidebarTableSearchEnabled",
  "autoSelectActiveSidebarNode",
  "sidebarOpenDatabaseOnSingleClick",
  "openTabsRestoreMode",
  "disconnectTabHandlingMode",
  "dataTabReuseMode",
  "openDataTabsNextToActive",
  "prefillNewQueryWithSelect",
  "generateSqlIncludeDatabaseName",
  "formatSqlOnSqlFileSave",
  "updateNotificationsEnabled",
  "sidebarObjectInfoMode",
  "sidebarAllowHorizontalScroll",
  "sidebarIndent",
  "sidebarFontSize",
  "sidebarHiddenTablePrefixes",
  "redisKeyTemplates",
  "exportBatchSize",
  "exportRowLimitEnabled",
  "exportRowLimit",
  "queryExportKeysetOptimizationEnabled",
  "globalDateTimeDisplayFormat",
  "globalDateTimeExportFormat",
  "globalDateTimeImportFormat",
  "updateDownloadSource",
  "toolbarItems",
  "snippets",
  "sqlShortcuts",
  "sqlVariableSubstitutionEnabled",
  "sqlVariableSyntaxOverrides",
  "continueOnErrorOnBatch",
  "clickTableNavigationTarget",
  "completionTriggerMode",
  "defaultTransactionMode",
] as const satisfies readonly (keyof EditorSettings)[];

export type EditorSettingsDraftKey = (typeof EDITOR_SETTINGS_DRAFT_KEYS)[number];
export type EditorSettingsDraft = Pick<EditorSettings, EditorSettingsDraftKey>;

function cloneDraftValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function normalizeTableOpenPageSizeDraft(value: unknown): number {
  // Match persistence so legacy, invalid, and fractional values cannot leave the dialog dirty after apply.
  return normalizeResultPageSize(value);
}

export function normalizeQueryResultMaxRowsDraft(value: unknown): number {
  return normalizeQueryResultMaxRows(value);
}

function normalizedDraftValue(key: EditorSettingsDraftKey, value: unknown): unknown {
  if (key === "pageSize" || key === "tableOpenPageSize") return normalizeTableOpenPageSizeDraft(value);
  if (key === "queryResultMaxRows") return normalizeQueryResultMaxRowsDraft(value);
  if (key === "completionTriggerMode") return normalizeCompletionTriggerMode(value);
  if (key === "redisKeyTemplates") return normalizeRedisKeyTemplates(value);
  return value;
}

function draftValueChanged(key: EditorSettingsDraftKey, a: unknown, b: unknown): boolean {
  return JSON.stringify(normalizedDraftValue(key, a)) !== JSON.stringify(normalizedDraftValue(key, b));
}

export function editorSettingsDraftFromSettings(settings: EditorSettings): EditorSettingsDraft {
  const draft = {} as EditorSettingsDraft;
  for (const key of EDITOR_SETTINGS_DRAFT_KEYS) {
    draft[key] = cloneDraftValue(normalizedDraftValue(key, settings[key])) as never;
  }
  return draft;
}

export function editorSettingsPatchFromDraft(draft: EditorSettingsDraft, base: EditorSettingsDraft): Partial<EditorSettings> {
  const patch: Partial<EditorSettings> = {};
  for (const key of EDITOR_SETTINGS_DRAFT_KEYS) {
    if (draftValueChanged(key, draft[key], base[key])) {
      patch[key] = cloneDraftValue(normalizedDraftValue(key, draft[key])) as never;
    }
  }
  return patch;
}

export function editorSettingsDraftChanged(draft: EditorSettingsDraft, base: EditorSettingsDraft): boolean {
  return EDITOR_SETTINGS_DRAFT_KEYS.some((key) => draftValueChanged(key, draft[key], base[key]));
}

// Closing the settings dialog (Escape, clicking outside, the X button, or the
// "Close" footer button) must never silently drop an unapplied draft — the
// dialog only persists shortcuts/sidebarActivation/etc. to the store on an
// explicit Apply. Route every close attempt through this check so an unsaved
// draft always surfaces a confirmation instead of vanishing.
export function shouldConfirmEditorSettingsDialogClose(nextOpen: boolean, hasUnsavedChanges: boolean): boolean {
  return nextOpen === false && hasUnsavedChanges;
}
