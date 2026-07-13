import type { EditorSettings } from "@/stores/settingsStore";

export const EDITOR_SETTINGS_DRAFT_KEYS = [
  "fontFamily",
  "fontSize",
  "uiFontFamily",
  "uiScale",
  "theme",
  "customThemes",
  "activeCustomThemeId",
  "executeMode",
  "showExecutionTargetPicker",
  "showStatementRunButtons",
  "showCurrentStatementFrame",
  "showInsertValueHints",
  "autoAliasTables",
  "wordWrap",
  "vimModeEnabled",
  "autoCloseBrackets",
  "sqlSemanticDiagnosticsMode",
  "confirmDangerousSqlExecution",
  "confirmUnsavedSqlClose",
  "appLayout",
  "showColumnCommentsInHeader",
  "showColumnTypesInHeader",
  "compactColumnHeaderActions",
  "dataGridQuickEntry",
  "infiniteScroll",
  "infiniteScrollMaxRows",
  "autoCalculateTotalRows",
  "tableColumnTemplateFields",
  "shortcuts",
  "sqlFormatter",
  "sidebarActivation",
  "sidebarObjectDisplay",
  "sidebarTableSearchEnabled",
  "autoSelectActiveSidebarNode",
  "openTabsRestoreMode",
  "disconnectTabHandlingMode",
  "reuseDataTab",
  "prefillNewQueryWithSelect",
  "updateNotificationsEnabled",
  "sidebarHideTableComments",
  "sidebarAllowHorizontalScroll",
  "sidebarHiddenTablePrefixes",
  "exportBatchSize",
  "exportRowLimitEnabled",
  "exportRowLimit",
  "queryExportKeysetOptimizationEnabled",
  "updateDownloadSource",
  "toolbarItems",
  "snippets",
  "sqlVariableSyntaxOverrides",
] as const satisfies readonly (keyof EditorSettings)[];

export type EditorSettingsDraftKey = (typeof EDITOR_SETTINGS_DRAFT_KEYS)[number];
export type EditorSettingsDraft = Pick<EditorSettings, EditorSettingsDraftKey>;

function cloneDraftValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function draftValueChanged(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export function editorSettingsDraftFromSettings(settings: EditorSettings): EditorSettingsDraft {
  const draft = {} as EditorSettingsDraft;
  for (const key of EDITOR_SETTINGS_DRAFT_KEYS) {
    draft[key] = cloneDraftValue(settings[key]) as never;
  }
  return draft;
}

export function editorSettingsPatchFromDraft(draft: EditorSettingsDraft, base: EditorSettingsDraft): Partial<EditorSettings> {
  const patch: Partial<EditorSettings> = {};
  for (const key of EDITOR_SETTINGS_DRAFT_KEYS) {
    if (draftValueChanged(draft[key], base[key])) {
      patch[key] = cloneDraftValue(draft[key]) as never;
    }
  }
  return patch;
}

export function editorSettingsDraftChanged(draft: EditorSettingsDraft, base: EditorSettingsDraft): boolean {
  return EDITOR_SETTINGS_DRAFT_KEYS.some((key) => draftValueChanged(draft[key], base[key]));
}
