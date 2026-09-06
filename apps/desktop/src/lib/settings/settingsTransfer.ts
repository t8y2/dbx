import { EDITOR_SETTINGS_DRAFT_KEYS, editorSettingsDraftFromSettings, type EditorSettingsDraftKey } from "./editorSettingsDraft";
import { DEFAULT_EDITOR_SETTINGS, normalizeEditorSettings, type EditorSettings } from "@/stores/settingsStore";

/**
 * Local backup / restore of application settings ("配置导入与导出").
 *
 * The transfer file is a versioned JSON document with a strict field
 * whitelist: only dialog-managed editor settings are serialized. Connection
 * data, saved SQL libraries, AI configuration and device-specific paths are
 * never part of the payload, and unknown fields in an imported file are
 * ignored instead of being written into the draft.
 */

export const SETTINGS_TRANSFER_FORMAT_VERSION = 1;

/** Upper bound for an import file; real settings files are a few dozen KB. */
export const MAX_SETTINGS_TRANSFER_FILE_BYTES = 5 * 1024 * 1024;

export type SettingsTransferCategoryId = "appearance" | "editor" | "formatter" | "navigation" | "data" | "shortcuts" | "snippets" | "other";

export type SettingsTransferParseErrorCode = "too-large" | "invalid-json" | "unsupported-version" | "invalid-structure" | "empty-settings" | "invalid-fields";

export interface SettingsTransferParseError {
  code: SettingsTransferParseErrorCode;
  /** Offending format version, or the first invalid field names. */
  detail?: string;
}

export interface ParsedSettingsTransfer {
  formatVersion: number;
  appVersion?: string;
  exportedAt?: string;
  /** Validated, normalized values for exactly the keys present in the file. */
  editorSettings: Partial<EditorSettings>;
  categories: SettingsTransferCategoryId[];
}

export interface SettingsTransferExportMeta {
  appVersion?: string;
}

export function buildSettingsTransferFilename(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `dbx-settings-${year}-${month}-${day}.json`;
}

/**
 * Serializes the saved editor settings into the transfer format. The draft
 * helper provides the whitelist, deep cloning and per-key normalization, so
 * the payload never contains fields outside `EDITOR_SETTINGS_DRAFT_KEYS`.
 */
export function serializeSettingsTransfer(settings: EditorSettings, meta: SettingsTransferExportMeta = {}): string {
  const payload = {
    formatVersion: SETTINGS_TRANSFER_FORMAT_VERSION,
    app: { name: "dbx", ...(meta.appVersion ? { version: meta.appVersion } : {}) },
    exportedAt: new Date().toISOString(),
    settings: {
      editor: editorSettingsDraftFromSettings(settings),
    },
  };
  return JSON.stringify(payload, null, 2);
}

const SETTINGS_TRANSFER_CATEGORY_ORDER: readonly SettingsTransferCategoryId[] = ["appearance", "editor", "formatter", "navigation", "data", "shortcuts", "snippets", "other"];

const SETTINGS_TRANSFER_CATEGORY_KEYS: Record<SettingsTransferCategoryId, readonly EditorSettingsDraftKey[]> = {
  appearance: ["fontFamily", "fontSize", "tableFontFamily", "uiFontFamily", "uiScale", "theme", "customThemes", "activeCustomThemeId", "toolbarItems", "updateNotificationsEnabled"],
  editor: [
    "executeMode",
    "defaultTransactionMode",
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
    "completionTriggerMode",
    "wordWrap",
    "vimModeEnabled",
    "autoCloseBrackets",
    "sqlSemanticDiagnosticsMode",
    "confirmDangerousSqlExecution",
    "continueOnErrorOnBatch",
    "confirmUnsavedSqlClose",
    "appCloseUnsavedTabsMode",
    "savedSqlOpenTargetMode",
    "prefillNewQueryWithSelect",
    "generateSqlIncludeDatabaseName",
    "formatSqlOnSqlFileSave",
    "showTableDdlHoverPreview",
    "sqlVariableSubstitutionEnabled",
    "sqlVariableSyntaxOverrides",
  ],
  formatter: ["sqlFormatter"],
  navigation: [
    "appLayout",
    "tabLayout",
    "tabPlacement",
    "tabGroupMode",
    "tabSortMode",
    "sidebarActivation",
    "sidebarObjectDisplay",
    "routineSourceOpenMode",
    "sidebarTableSearchEnabled",
    "autoSelectActiveSidebarNode",
    "sidebarBrowseObjectsOnDatabaseActivation",
    "openTabsRestoreMode",
    "disconnectTabHandlingMode",
    "dataTabReuseMode",
    "openDataTabsNextToActive",
    "clickTableNavigationTarget",
    "sidebarObjectInfoMode",
    "sidebarAllowHorizontalScroll",
    "sidebarShowTooltips",
    "sidebarIndent",
    "sidebarFontSize",
    "sidebarHiddenTablePrefixes",
    "sidebarCopyTableNameSeparator",
    "sidebarCopyTableNameIncludeSchema",
  ],
  data: [
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
    "flatteningMultiLineText",
    "pageSize",
    "tableOpenPageSize",
    "queryResultMaxRowsEnabled",
    "queryResultMaxRows",
    "infiniteScroll",
    "regexMaxMatchCount",
    "autoCalculateTotalRows",
    "tableColumnTemplateFields",
    "redisKeyTemplates",
    "exportBatchSize",
    "exportRowLimitEnabled",
    "exportRowLimit",
    "queryExportKeysetOptimizationEnabled",
    "globalDateTimeDisplayFormat",
    "globalDateTimeExportFormat",
    "globalDateTimeImportFormat",
  ],
  shortcuts: ["shortcuts", "sqlShortcuts"],
  snippets: ["snippets"],
  other: ["updateDownloadSource"],
};

const KEY_TO_CATEGORY = new Map<string, SettingsTransferCategoryId>();
for (const [category, keys] of Object.entries(SETTINGS_TRANSFER_CATEGORY_KEYS) as [SettingsTransferCategoryId, readonly EditorSettingsDraftKey[]][]) {
  for (const key of keys) KEY_TO_CATEGORY.set(key, category);
}

export function transferCategoryForKey(key: string): SettingsTransferCategoryId | undefined {
  return KEY_TO_CATEGORY.get(key);
}

export function collectTransferCategories(keys: readonly string[]): SettingsTransferCategoryId[] {
  const present = new Set<SettingsTransferCategoryId>();
  for (const key of keys) {
    const category = KEY_TO_CATEGORY.get(key);
    if (category) present.add(category);
  }
  return sortTransferCategories(present);
}

/** Orders category ids by their fixed display order. */
export function sortTransferCategories(categories: Iterable<SettingsTransferCategoryId>): SettingsTransferCategoryId[] {
  const present = new Set(categories);
  return SETTINGS_TRANSFER_CATEGORY_ORDER.filter((category) => present.has(category));
}

/** i18n keys used to render the affected categories in the import dialog. */
export const SETTINGS_TRANSFER_CATEGORY_LABEL_KEYS: Record<SettingsTransferCategoryId, string> = {
  appearance: "settings.appearanceTab",
  editor: "settings.editorTab",
  formatter: "settings.sqlFormatterTab",
  navigation: "settings.navigationTab",
  data: "settings.dataTab",
  shortcuts: "settings.shortcutsTab",
  snippets: "settings.snippetsTab",
  other: "settings.settingsTransferCategoryOther",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonKindOf(value: unknown): string {
  return Array.isArray(value) ? "array" : typeof value;
}

// Expected JSON kind per whitelisted key, derived from the defaults. The store
// normalizer is defensive but a few keys pass values through unchanged, so the
// kind check is what rejects wrong-typed fields (e.g. a string fontSize).
const EXPECTED_JSON_KINDS = new Map<string, string>(EDITOR_SETTINGS_DRAFT_KEYS.map((key) => [key, jsonKindOf((DEFAULT_EDITOR_SETTINGS as unknown as Record<string, unknown>)[key])]));

/**
 * Parses and validates an imported settings file. Validation is all-or-
 * nothing: the caller only receives values once every whitelisted field in
 * the file passed the checks, so a rejected file can never partially modify
 * the settings draft.
 *
 * Scalar values (boolean/number/string) must survive the store's own
 * normalizer unchanged — an out-of-domain enum or a clamped number comes
 * back different and rejects the import. Objects and arrays are sanitized
 * through the same normalizer and accepted in their normalized form.
 */
export function parseSettingsTransferFile(text: string): { ok: true; value: ParsedSettingsTransfer } | { ok: false; error: SettingsTransferParseError } {
  if (new TextEncoder().encode(text).byteLength > MAX_SETTINGS_TRANSFER_FILE_BYTES) {
    return { ok: false, error: { code: "too-large" } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: { code: "invalid-json" } };
  }
  if (!isPlainObject(parsed)) return { ok: false, error: { code: "invalid-structure" } };

  const formatVersion = parsed.formatVersion;
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion) || formatVersion !== SETTINGS_TRANSFER_FORMAT_VERSION) {
    return { ok: false, error: { code: "unsupported-version", detail: typeof formatVersion === "number" ? String(formatVersion) : undefined } };
  }

  const settings = parsed.settings;
  if (!isPlainObject(settings)) return { ok: false, error: { code: "invalid-structure" } };
  const editor = settings.editor;
  if (!isPlainObject(editor)) return { ok: false, error: { code: "empty-settings" } };

  const presentKeys = EDITOR_SETTINGS_DRAFT_KEYS.filter((key) => key in editor);
  if (presentKeys.length === 0) return { ok: false, error: { code: "empty-settings" } };

  // Run the imported values through the same normalizer the store applies on
  // load. Defaults are cloned first so the shared constant can never be
  // mutated by a malformed file.
  const probe = deepClone(DEFAULT_EDITOR_SETTINGS) as EditorSettings;
  for (const key of presentKeys) {
    (probe as unknown as Record<string, unknown>)[key] = editor[key];
  }
  const normalized = normalizeEditorSettings(probe);

  const imported: Partial<EditorSettings> = {};
  const invalidKeys: string[] = [];
  for (const key of presentKeys) {
    const raw = editor[key];
    const value = (normalized as unknown as Record<string, unknown>)[key];
    if (jsonKindOf(raw) !== EXPECTED_JSON_KINDS.get(key)) {
      invalidKeys.push(key);
      continue;
    }
    if (typeof raw === "boolean" || typeof raw === "number" || typeof raw === "string") {
      if (typeof raw !== typeof value || value !== raw) {
        invalidKeys.push(key);
        continue;
      }
      imported[key as EditorSettingsDraftKey] = deepClone(value) as never;
    } else if (Array.isArray(raw)) {
      if (!Array.isArray(value)) {
        invalidKeys.push(key);
        continue;
      }
      imported[key as EditorSettingsDraftKey] = deepClone(value) as never;
    } else if (isPlainObject(raw)) {
      if (!isPlainObject(value)) {
        invalidKeys.push(key);
        continue;
      }
      imported[key as EditorSettingsDraftKey] = deepClone(value) as never;
    } else {
      invalidKeys.push(key);
    }
  }
  if (invalidKeys.length > 0) {
    return { ok: false, error: { code: "invalid-fields", detail: invalidKeys.slice(0, 5).join(", ") } };
  }

  const app = isPlainObject(parsed.app) ? parsed.app : {};
  const rawAppVersion = typeof app.version === "string" ? app.version.trim() : "";
  const rawExportedAt = typeof parsed.exportedAt === "string" ? parsed.exportedAt : "";

  return {
    ok: true,
    value: {
      formatVersion: SETTINGS_TRANSFER_FORMAT_VERSION,
      ...(rawAppVersion ? { appVersion: rawAppVersion } : {}),
      ...(rawExportedAt ? { exportedAt: rawExportedAt } : {}),
      editorSettings: imported,
      categories: collectTransferCategories(Object.keys(imported)),
    },
  };
}
