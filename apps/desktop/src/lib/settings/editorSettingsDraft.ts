import type { EditorSettings } from "@/stores/settingsStore";
import { normalizeResultPageSize } from "@/lib/dataGrid/paginationPageSize";
import { normalizeCompletionTriggerMode } from "@/lib/sql/sqlCompletionTriggerPolicy";

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
  "globalConnectTimeoutSecs",
  "globalQueryTimeoutSecs",
  "showExecutionTargetPicker",
  "showStatementRunButtons",
  "showCurrentStatementFrame",
  "showInsertValueHints",
  "autoAliasTables",
  "insertSpaceAfterCompletion",
  "wordWrap",
  "vimModeEnabled",
  "autoCloseBrackets",
  "sqlSemanticDiagnosticsMode",
  "confirmDangerousSqlExecution",
  "confirmUnsavedSqlClose",
  "savedSqlOpenTargetMode",
  "appLayout",
  "tabLayout",
  "showColumnCommentsInHeader",
  "showColumnTypesInHeader",
  "showIndexIndicatorsInHeader",
  "compactColumnHeaderActions",
  "dataGridQuickEntry",
  "dataGridAutoTransposeSingleRow",
  "tableOpenPageSize",
  "infiniteScroll",
  "infiniteScrollMaxRows",
  "regexMaxMatchCount",
  "autoCalculateTotalRows",
  "tableColumnTemplateFields",
  "shortcuts",
  "sqlFormatter",
  "sidebarActivation",
  "sidebarObjectDisplay",
  "routineSourceOpenMode",
  "sidebarTableSearchEnabled",
  "autoSelectActiveSidebarNode",
  "openTabsRestoreMode",
  "disconnectTabHandlingMode",
  "dataTabReuseMode",
  "prefillNewQueryWithSelect",
  "updateNotificationsEnabled",
  "sidebarObjectInfoMode",
  "sidebarAllowHorizontalScroll",
  "sidebarHiddenTablePrefixes",
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
  "sqlVariableSyntaxOverrides",
  "continueOnErrorOnBatch",
  "clickTableNavigationTarget",
  "completionTriggerMode",
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

function normalizedDraftValue(key: EditorSettingsDraftKey, value: unknown): unknown {
  if (key === "tableOpenPageSize") return normalizeTableOpenPageSizeDraft(value);
  if (key === "completionTriggerMode") return normalizeCompletionTriggerMode(value);
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
