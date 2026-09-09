import { EDITOR_SETTINGS_DRAFT_KEYS, editorSettingsDraftFromSettings, type EditorSettingsDraftKey } from "./editorSettingsDraft";
import { DEFAULT_CUSTOM_THEME_COLORS, DEFAULT_CUSTOM_THEME_DDL_COLORS, DEFAULT_EDITOR_SETTINGS, DEFAULT_TOOLBAR_ITEMS, normalizeEditorSettings, type EditorSettings } from "@/stores/settingsStore";
import { EDITOR_MAX_FONT_SIZE, EDITOR_MIN_FONT_SIZE } from "@/lib/editor/editorZoom";
import { DATA_GRID_TYPE_COLOR_KEYS, DATA_GRID_TYPE_COLOR_SCHEME_AUTO_ID } from "@/lib/dataGrid/dataGridTypeColorScheme";
import { SHORTCUT_DEFINITIONS } from "@/lib/editor/shortcutRegistry";
import { isCompleteSqlFormatterSettings } from "@/lib/sql/sqlFormatterConfig";
import { SQL_VARIABLE_SYNTAX_KEYS } from "@/lib/sql/sqlVariableSyntax";

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
  appearance: ["fontFamily", "fontSize", "tableFontFamily", "uiFontFamily", "uiScale", "theme", "customThemes", "activeCustomThemeId", "backgroundImage", "toolbarItems", "updateNotificationsEnabled"],
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
    "generateSqlQuoteIdentifiers",
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
    "dataGridKeepFilterEditorExpanded",
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
    "externalSqlEditorMaxMb",
    "infiniteScroll",
    "regexMaxMatchCount",
    "autoCalculateTotalRows",
    "tableColumnTemplateFields",
    "redisKeyTemplates",
    "exportBatchSize",
    "csvQuoteMode",
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

/**
 * UTF-8 needs 1–3 bytes per UTF-16 code unit, so the character count alone
 * settles every text outside the ambiguous expansion band. The precise byte
 * count — which allocates an encoded copy of the whole text — is only built
 * for inputs whose size could still tip over the limit after expansion.
 */
function exceedsSettingsTransferSizeLimit(text: string): boolean {
  if (text.length > MAX_SETTINGS_TRANSFER_FILE_BYTES) return true;
  if (text.length * 3 <= MAX_SETTINGS_TRANSFER_FILE_BYTES) return false;
  return new TextEncoder().encode(text).byteLength > MAX_SETTINGS_TRANSFER_FILE_BYTES;
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
 * Keys whose store normalizer keeps any non-nullish value as-is (only a
 * nullish fallback). For these, the round-trip equality check cannot catch a
 * bad value: `fontSize: 0` or `appLayout: "invalid"` would survive untouched
 * and later be persisted. Each entry restates the domain the settings UI and
 * the clamping helpers enforce, so importing an out-of-range number, a broken
 * enum or a non-boolean flag refuses the whole file instead.
 */
const PASS_THROUGH_BOOLEAN_KEYS = [
  "wordWrap",
  "showExecutionTargetPicker",
  "autoAliasTables",
  "confirmDangerousSqlExecution",
  "confirmUnsavedSqlClose",
  "showColumnCommentsInHeader",
  "showColumnTypesInHeader",
  "colorizeDataGridCellTypes",
  "showIndexIndicatorsInHeader",
  "compactColumnHeaderActions",
  "dataGridQuickEntry",
  "flatteningMultiLineText",
  "infiniteScroll",
  "autoCalculateTotalRows",
  "autoSelectActiveSidebarNode",
  "sidebarAllowHorizontalScroll",
  "sidebarShowTooltips",
  "updateNotificationsEnabled",
] as const satisfies readonly EditorSettingsDraftKey[];

const PASS_THROUGH_FIELD_VALIDATORS: Partial<Record<EditorSettingsDraftKey, (value: unknown) => boolean>> = {
  // The editor font slider and the Ctrl+wheel zoom both clamp to this range.
  fontSize: (value) => typeof value === "number" && Number.isFinite(value) && value >= EDITOR_MIN_FONT_SIZE && value <= EDITOR_MAX_FONT_SIZE,
  appLayout: (value) => value === "separated" || value === "classic",
  activeCustomThemeId: (value) => typeof value === "string" && value.trim().length > 0,
  // normalizeToolbarItems keeps unknown/typed values for every known key, so
  // each one must already be the boolean the UI writes, and no extra key may
  // appear.
  toolbarItems: (value) => isPlainObject(value) && Object.keys(DEFAULT_TOOLBAR_ITEMS).every((key) => typeof value[key] === "boolean") && Object.keys(value).every((key) => key in DEFAULT_TOOLBAR_ITEMS),
  ...Object.fromEntries(PASS_THROUGH_BOOLEAN_KEYS.map((key) => [key, (value: unknown) => typeof value === "boolean"])),
};

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isArrayOfShape(value: unknown, isItem: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(isItem);
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyStringArray(value: unknown): boolean {
  return isStringArray(value) && (value as string[]).every((item) => item.trim().length > 0);
}

/** Required color keys of a custom editor theme, keyed by expected JSON kind. */
function valueKindShape(defaults: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, typeof value]));
}

const CUSTOM_THEME_COLORS_SHAPE = valueKindShape(DEFAULT_CUSTOM_THEME_COLORS as unknown as Record<string, unknown>);
const CUSTOM_THEME_DDL_COLORS_SHAPE = valueKindShape(DEFAULT_CUSTOM_THEME_DDL_COLORS as unknown as Record<string, unknown>);

/**
 * Optional color keys of a custom editor theme. They are absent from
 * DEFAULT_CUSTOM_THEME_COLORS, so the defaults-derived shape above cannot
 * cover them and a wrong-typed value (e.g. `background: {}`) would otherwise
 * pass validation and reach the persisted settings.
 */
const CUSTOM_THEME_OPTIONAL_COLOR_KEYS = ["background", "foreground"] as const;

function hasValidOptionalColorKinds(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return CUSTOM_THEME_OPTIONAL_COLOR_KEYS.every((key) => value[key] === undefined || typeof value[key] === "string");
}

function hasRequiredValueKinds(value: unknown, shape: Record<string, string>): boolean {
  if (!isPlainObject(value)) return false;
  return Object.entries(shape).every(([key, kind]) => typeof value[key] === kind);
}

function isCustomThemeItem(value: unknown): boolean {
  return isPlainObject(value) && isNonEmptyTrimmedString(value.id) && isNonEmptyTrimmedString(value.name) && hasRequiredValueKinds(value.colors, CUSTOM_THEME_COLORS_SHAPE) && hasValidOptionalColorKinds(value.colors) && hasRequiredValueKinds(value.ddlColors, CUSTOM_THEME_DDL_COLORS_SHAPE);
}

// The store normalizer only writes #rrggbb values, matching normalizeDataGridTypeColors.
const DATA_GRID_TYPE_HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function isDataGridTypeColorSchemeItem(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  // The auto id is the "follow the built-in palette" sentinel, never a scheme.
  if (!isNonEmptyTrimmedString(value.id) || value.id === DATA_GRID_TYPE_COLOR_SCHEME_AUTO_ID) return false;
  if (!isNonEmptyTrimmedString(value.name)) return false;
  const colors = value.colors;
  if (!isPlainObject(colors)) return false;
  return DATA_GRID_TYPE_COLOR_KEYS.every((key) => {
    const color = colors[key];
    return typeof color === "string" && DATA_GRID_TYPE_HEX_COLOR_RE.test(color);
  });
}

function isSqlSnippetItem(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyTrimmedString(value.id) || !isNonEmptyTrimmedString(value.label) || !isNonEmptyTrimmedString(value.prefix) || typeof value.body !== "string") return false;
  return value.enabled === undefined || typeof value.enabled === "boolean";
}

function isSqlShortcutActionItem(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyTrimmedString(value.id) || !isNonEmptyTrimmedString(value.label) || typeof value.shortcut !== "string" || typeof value.sql !== "string") return false;
  return value.enabled === undefined || typeof value.enabled === "boolean";
}

const SHORTCUT_ACTION_IDS = new Set<string>(SHORTCUT_DEFINITIONS.map((definition) => definition.id));

/** Normalized shape: exactly the known action ids, each bound to a string. */
function isShortcutSettingsShape(value: unknown): boolean {
  return isPlainObject(value) && Object.entries(value).every(([key, entry]) => SHORTCUT_ACTION_IDS.has(key) && typeof entry === "string");
}

/** Raw shape: overrides for known actions must be strings; unknown keys stay ignored for forward compatibility. */
function isRawShortcutSettingsShape(value: unknown): boolean {
  return isPlainObject(value) && Object.entries(value).every(([key, entry]) => !SHORTCUT_ACTION_IDS.has(key) || typeof entry === "string");
}

/**
 * Raw shape: every known toolbar key must already be a boolean.
 * normalizeToolbarItems coerces `exclusiveRightSidebarPanels` with `!== false`
 * (and fills the rest with nullish defaults), so a non-boolean like "no" would
 * otherwise be silently turned into `true` and pass the normalized round-trip
 * check. Unknown keys stay ignored for forward compatibility.
 */
function isRawToolbarItemsShape(value: unknown): boolean {
  return isPlainObject(value) && Object.entries(value).every(([key, entry]) => !(key in DEFAULT_TOOLBAR_ITEMS) || typeof entry === "boolean");
}

const SQL_VARIABLE_SYNTAX_KEY_SET = new Set<string>(SQL_VARIABLE_SYNTAX_KEYS);

function isSqlVariableSyntaxOverridesShape(value: unknown, isAllowedToggle: (toggle: unknown) => boolean): boolean {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((entry) => isPlainObject(entry) && Object.entries(entry).every(([key, toggle]) => SQL_VARIABLE_SYNTAX_KEY_SET.has(key) && isAllowedToggle(toggle)));
}

/**
 * Full nested-schema checks for the structured (array/object) fields, run on
 * the normalized value. The store normalizer only sanitizes some of them —
 * notably `normalizeEditorSettings` keeps `customThemes` items that lack
 * `id` or `name` — so without these checks a file like
 * `{"customThemes": [{}]}` would import cleanly and later corrupt the
 * persisted settings.
 */
const NESTED_FIELD_VALIDATORS: Partial<Record<EditorSettingsDraftKey, (value: unknown) => boolean>> = {
  customThemes: (value) => isArrayOfShape(value, isCustomThemeItem),
  dataGridTypeColorSchemes: (value) => isArrayOfShape(value, isDataGridTypeColorSchemeItem),
  tableColumnTemplateFields: isNonEmptyStringArray,
  shortcuts: isShortcutSettingsShape,
  sqlFormatter: isCompleteSqlFormatterSettings,
  sidebarHiddenTablePrefixes: isNonEmptyStringArray,
  redisKeyTemplates: isNonEmptyStringArray,
  snippets: (value) => isArrayOfShape(value, isSqlSnippetItem),
  sqlShortcuts: (value) => isArrayOfShape(value, isSqlShortcutActionItem),
  sqlVariableSyntaxOverrides: (value) => isSqlVariableSyntaxOverridesShape(value, (toggle) => toggle === false),
};

/**
 * The same nested schemas applied to the raw file values before
 * normalization. This rejects payloads the normalizer would silently repair
 * by dropping entries or substituting defaults — importing those would
 * overwrite the user's data (custom schemes, snippets, formatter options, …)
 * with sanitized defaults instead of surfacing the malformed file. Running
 * them before the normalizer also keeps `normalizeEditorSettings` from
 * throwing on malformed containers it does not sanitize (e.g. a null item
 * inside `customThemes`).
 */
const RAW_STRUCTURED_FIELD_VALIDATORS: Partial<Record<EditorSettingsDraftKey, (value: unknown) => boolean>> = {
  customThemes: (value) => isArrayOfShape(value, isCustomThemeItem),
  dataGridTypeColorSchemes: (value) => isArrayOfShape(value, isDataGridTypeColorSchemeItem),
  tableColumnTemplateFields: isStringArray,
  shortcuts: isRawShortcutSettingsShape,
  toolbarItems: isRawToolbarItemsShape,
  sqlFormatter: isCompleteSqlFormatterSettings,
  sidebarHiddenTablePrefixes: isStringArray,
  redisKeyTemplates: isStringArray,
  snippets: (value) => isArrayOfShape(value, isSqlSnippetItem),
  sqlShortcuts: (value) => isArrayOfShape(value, isSqlShortcutActionItem),
  sqlVariableSyntaxOverrides: (value) => isSqlVariableSyntaxOverridesShape(value, (toggle) => typeof toggle === "boolean"),
};

/**
 * Parses and validates an imported settings file. Validation is all-or-
 * nothing: the caller only receives values once every whitelisted field in
 * the file passed the checks, so a rejected file can never partially modify
 * the settings draft.
 *
 * Raw JSON-kind and raw structured checks (see
 * RAW_STRUCTURED_FIELD_VALIDATORS) run first, before the normalizer, so a
 * malformed container is reported as `invalid-fields` instead of throwing
 * inside a store normalizer. Scalar values (boolean/number/string) must
 * survive the store's own normalizer unchanged — an out-of-domain enum or a
 * clamped number comes back different and rejects the import. Pass-through
 * fields (see PASS_THROUGH_FIELD_VALIDATORS) get an explicit domain check
 * instead, because the normalizer keeps them as-is. Objects and arrays are
 * sanitized through the same normalizer and must additionally satisfy a full
 * nested schema (see NESTED_FIELD_VALIDATORS): malformed nested payloads are
 * rejected instead of being silently repaired or persisted.
 */
export function parseSettingsTransferFile(text: string): { ok: true; value: ParsedSettingsTransfer } | { ok: false; error: SettingsTransferParseError } {
  if (exceedsSettingsTransferSizeLimit(text)) {
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

  // Old exports used the inverse `dataGridAutoHideFilterBuilder` flag. Keep
  // accepting it, but normalize it into the single current preference before
  // applying the strict whitelist below.
  if (!("dataGridKeepFilterEditorExpanded" in editor) && typeof editor.dataGridAutoHideFilterBuilder === "boolean") {
    editor.dataGridKeepFilterEditorExpanded = !editor.dataGridAutoHideFilterBuilder;
  }

  const presentKeys = EDITOR_SETTINGS_DRAFT_KEYS.filter((key) => key in editor);
  if (presentKeys.length === 0) return { ok: false, error: { code: "empty-settings" } };

  // Validate the raw file values BEFORE the normalizer runs. Some store
  // normalizers assume well-formed containers (e.g. customThemes items must
  // expose `name`) and throw on malformed input instead of sanitizing it, so
  // a broken file must be rejected here and surface as `invalid-fields`
  // rather than crashing the parse.
  const invalidKeys: string[] = [];
  for (const key of presentKeys) {
    const raw = editor[key];
    if (jsonKindOf(raw) !== EXPECTED_JSON_KINDS.get(key)) {
      invalidKeys.push(key);
      continue;
    }
    const rawValidator = RAW_STRUCTURED_FIELD_VALIDATORS[key];
    if (rawValidator && !rawValidator(raw)) {
      invalidKeys.push(key);
    }
  }
  if (invalidKeys.length > 0) {
    return { ok: false, error: { code: "invalid-fields", detail: invalidKeys.slice(0, 5).join(", ") } };
  }

  // Run the imported values through the same normalizer the store applies on
  // load. Defaults are cloned first so the shared constant can never be
  // mutated by a malformed file.
  const probe = deepClone(DEFAULT_EDITOR_SETTINGS) as EditorSettings;
  for (const key of presentKeys) {
    (probe as unknown as Record<string, unknown>)[key] = editor[key];
  }
  const normalized = normalizeEditorSettings(probe);

  const imported: Partial<EditorSettings> = {};
  for (const key of presentKeys) {
    const raw = editor[key];
    const value = (normalized as unknown as Record<string, unknown>)[key];
    const validator = PASS_THROUGH_FIELD_VALIDATORS[key] ?? NESTED_FIELD_VALIDATORS[key];
    if (validator && !validator(value)) {
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
