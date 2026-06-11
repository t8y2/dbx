export const SQL_FORMATTER_CONFIG_VERSION = 1;
export const SQL_FORMATTER_CONFIG_FORMATTER = "sql-formatter";
export const SQL_FORMATTER_EDITOR_SCOPE = "sqlFormatterConfigJsonEditor";

const CASE_VALUES = ["preserve", "upper", "lower"] as const;
const INDENT_STYLE_VALUES = ["standard", "tabularLeft", "tabularRight"] as const;
const LOGICAL_OPERATOR_NEWLINE_VALUES = ["before", "after"] as const;
const TAB_WIDTH_VALUES = [2, 4] as const;
const EXPRESSION_WIDTH_VALUES = [50, 80, 120] as const;
const LINES_BETWEEN_QUERIES_VALUES = [0, 1, 2] as const;
const SQL_FORMATTER_PLATFORM_VALUES = ["windows", "linux", "macos"] as const;
const SQL_FORMATTER_PARAM_TYPE_MARKERS = ["?", ":", "$"] as const;
const SQL_FORMATTER_NAMED_PARAM_TYPE_MARKERS = [":", "@", "$"] as const;
const SQL_FORMATTER_LEGACY_OPTION_KEYS = new Set(["params"]);

export type SqlFormatterCase = (typeof CASE_VALUES)[number];
export type SqlFormatterIndentStyle = (typeof INDENT_STYLE_VALUES)[number];
export type SqlFormatterLogicalOperatorNewline = (typeof LOGICAL_OPERATOR_NEWLINE_VALUES)[number];
export type SqlFormatterTabWidth = (typeof TAB_WIDTH_VALUES)[number];
export type SqlFormatterExpressionWidth = (typeof EXPRESSION_WIDTH_VALUES)[number];
export type SqlFormatterLinesBetweenQueries = (typeof LINES_BETWEEN_QUERIES_VALUES)[number];
export type SqlFormatterPlatform = (typeof SQL_FORMATTER_PLATFORM_VALUES)[number];

export interface SqlFormatterCustomParameter {
  regex: string;
}

export interface SqlFormatterParamTypes {
  positional?: boolean;
  numbered?: ("?" | ":" | "$")[];
  named?: (":" | "@" | "$")[];
  quoted?: (":" | "@" | "$")[];
  custom?: SqlFormatterCustomParameter[];
}

export interface SqlFormatterOptionSettings {
  keywordCase: SqlFormatterCase;
  dataTypeCase: SqlFormatterCase;
  functionCase: SqlFormatterCase;
  identifierCase: SqlFormatterCase;
  indentStyle: SqlFormatterIndentStyle;
  useTabs: boolean;
  tabWidth: SqlFormatterTabWidth;
  logicalOperatorNewline: SqlFormatterLogicalOperatorNewline;
  expressionWidth: SqlFormatterExpressionWidth;
  linesBetweenQueries: SqlFormatterLinesBetweenQueries;
  denseOperators: boolean;
  newlineBeforeSemicolon: boolean;
  paramTypes: SqlFormatterParamTypes | null;
}

export type SqlFormatterEditorShortcutId = "find" | "replace" | "indentMore" | "indentLess" | "duplicateLine" | "deleteLine" | "moveLineUp" | "moveLineDown" | "copyLineUp" | "copyLineDown" | "undo" | "redo" | "selectAll" | "formatJson" | "applyConfig";

export type SqlFormatterEditorShortcutAction = "openSearchPanel" | "indentMore" | "indentLess" | "copyLineDown" | "copyLineUp" | "deleteLine" | "moveLineUp" | "moveLineDown" | "undo" | "redo" | "selectAll" | "formatJson" | "applyJsonDraft";

export interface SqlFormatterEditorShortcutKeys {
  windows: string;
  linux: string;
  macos: string;
}

export interface SqlFormatterEditorShortcut {
  id: SqlFormatterEditorShortcutId;
  action: SqlFormatterEditorShortcutAction;
  keys: SqlFormatterEditorShortcutKeys;
  enabled: boolean;
}

export interface SqlFormatterEditorSettings {
  scope: typeof SQL_FORMATTER_EDITOR_SCOPE;
  platforms: SqlFormatterPlatform[];
  shortcuts: SqlFormatterEditorShortcut[];
}

export interface SqlFormatterSettings extends SqlFormatterOptionSettings {
  editor: SqlFormatterEditorSettings;
}

export interface SqlFormatterConfigFile {
  version: typeof SQL_FORMATTER_CONFIG_VERSION;
  formatter: typeof SQL_FORMATTER_CONFIG_FORMATTER;
  options: SqlFormatterOptionSettings;
  editor: SqlFormatterEditorSettings;
}

export type SqlFormatterConfigParseResult = { ok: true; settings: SqlFormatterSettings } | { ok: false; message: string };
export type SqlFormatterEditorValidationResult = { ok: true } | { ok: false; message: string };

export const DEFAULT_SQL_FORMATTER_EDITOR_SHORTCUTS: SqlFormatterEditorShortcut[] = [
  { id: "find", action: "openSearchPanel", keys: { windows: "Ctrl+F", linux: "Ctrl+F", macos: "Cmd+F" }, enabled: true },
  { id: "replace", action: "openSearchPanel", keys: { windows: "Ctrl+H", linux: "Ctrl+H", macos: "Cmd+Option+F" }, enabled: true },
  { id: "indentMore", action: "indentMore", keys: { windows: "Tab", linux: "Tab", macos: "Tab" }, enabled: true },
  { id: "indentLess", action: "indentLess", keys: { windows: "Shift+Tab", linux: "Shift+Tab", macos: "Shift+Tab" }, enabled: true },
  { id: "duplicateLine", action: "copyLineDown", keys: { windows: "Ctrl+D", linux: "Ctrl+D", macos: "Cmd+D" }, enabled: true },
  { id: "deleteLine", action: "deleteLine", keys: { windows: "Ctrl+Shift+K", linux: "Ctrl+Shift+K", macos: "Cmd+Shift+K" }, enabled: true },
  { id: "moveLineUp", action: "moveLineUp", keys: { windows: "Alt+Up", linux: "Alt+Up", macos: "Option+Up" }, enabled: true },
  { id: "moveLineDown", action: "moveLineDown", keys: { windows: "Alt+Down", linux: "Alt+Down", macos: "Option+Down" }, enabled: true },
  { id: "copyLineUp", action: "copyLineUp", keys: { windows: "Shift+Alt+Up", linux: "Shift+Alt+Up", macos: "Shift+Option+Up" }, enabled: true },
  { id: "copyLineDown", action: "copyLineDown", keys: { windows: "Shift+Alt+Down", linux: "Shift+Alt+Down", macos: "Shift+Option+Down" }, enabled: true },
  { id: "undo", action: "undo", keys: { windows: "Ctrl+Z", linux: "Ctrl+Z", macos: "Cmd+Z" }, enabled: true },
  { id: "redo", action: "redo", keys: { windows: "Ctrl+Y", linux: "Ctrl+Shift+Z", macos: "Cmd+Shift+Z" }, enabled: true },
  { id: "selectAll", action: "selectAll", keys: { windows: "Ctrl+A", linux: "Ctrl+A", macos: "Cmd+A" }, enabled: true },
  { id: "formatJson", action: "formatJson", keys: { windows: "Shift+Alt+F", linux: "Shift+Alt+F", macos: "Shift+Cmd+F" }, enabled: true },
  { id: "applyConfig", action: "applyJsonDraft", keys: { windows: "Ctrl+S", linux: "Ctrl+S", macos: "Cmd+S" }, enabled: true },
];

export const DEFAULT_SQL_FORMATTER_SETTINGS: SqlFormatterSettings = {
  keywordCase: "upper",
  dataTypeCase: "preserve",
  functionCase: "preserve",
  identifierCase: "preserve",
  indentStyle: "standard",
  useTabs: false,
  tabWidth: 2,
  logicalOperatorNewline: "before",
  expressionWidth: 50,
  linesBetweenQueries: 1,
  denseOperators: false,
  newlineBeforeSemicolon: false,
  paramTypes: null,
  editor: {
    scope: SQL_FORMATTER_EDITOR_SCOPE,
    platforms: [...SQL_FORMATTER_PLATFORM_VALUES],
    shortcuts: cloneShortcuts(DEFAULT_SQL_FORMATTER_EDITOR_SHORTCUTS),
  },
};

const SQL_FORMATTER_OPTION_KEYS = new Set<keyof SqlFormatterOptionSettings>([
  "keywordCase",
  "dataTypeCase",
  "functionCase",
  "identifierCase",
  "indentStyle",
  "useTabs",
  "tabWidth",
  "logicalOperatorNewline",
  "expressionWidth",
  "linesBetweenQueries",
  "denseOperators",
  "newlineBeforeSemicolon",
  "paramTypes",
]);

const SQL_FORMATTER_OPTION_VALIDATORS: Record<keyof SqlFormatterOptionSettings, (value: unknown) => boolean> = {
  keywordCase: (value) => isStringChoice(value, CASE_VALUES),
  dataTypeCase: (value) => isStringChoice(value, CASE_VALUES),
  functionCase: (value) => isStringChoice(value, CASE_VALUES),
  identifierCase: (value) => isStringChoice(value, CASE_VALUES),
  indentStyle: (value) => isStringChoice(value, INDENT_STYLE_VALUES),
  useTabs: (value) => typeof value === "boolean",
  tabWidth: (value) => isNumberChoice(value, TAB_WIDTH_VALUES),
  logicalOperatorNewline: (value) => isStringChoice(value, LOGICAL_OPERATOR_NEWLINE_VALUES),
  expressionWidth: (value) => isNumberChoice(value, EXPRESSION_WIDTH_VALUES),
  linesBetweenQueries: (value) => isNumberChoice(value, LINES_BETWEEN_QUERIES_VALUES),
  denseOperators: (value) => typeof value === "boolean",
  newlineBeforeSemicolon: (value) => typeof value === "boolean",
  paramTypes: isSqlFormatterParamTypes,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringChoice(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}

function isNumberChoice(value: unknown, values: readonly number[]): boolean {
  return typeof value === "number" && values.includes(value);
}

function isMarkerArray<T extends readonly string[]>(value: unknown, markers: T): value is T[number][] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && markers.includes(item));
}

function isCustomParameter(value: unknown): value is SqlFormatterCustomParameter {
  if (!isObject(value) || typeof value.regex !== "string" || value.regex.length === 0 || !Object.keys(value).every((key) => key === "regex")) return false;
  try {
    new RegExp(`(?:${value.regex})`, "uy");
    return true;
  } catch {
    return false;
  }
}

function isSqlFormatterParamTypes(value: unknown): value is SqlFormatterParamTypes | null {
  if (value === null) return true;
  if (!isObject(value)) return false;
  if (!Object.keys(value).every((key) => ["positional", "numbered", "named", "quoted", "custom"].includes(key))) return false;
  if (value.positional !== undefined && typeof value.positional !== "boolean") return false;
  if (value.numbered !== undefined && !isMarkerArray(value.numbered, SQL_FORMATTER_PARAM_TYPE_MARKERS)) return false;
  if (value.named !== undefined && !isMarkerArray(value.named, SQL_FORMATTER_NAMED_PARAM_TYPE_MARKERS)) return false;
  if (value.quoted !== undefined && !isMarkerArray(value.quoted, SQL_FORMATTER_NAMED_PARAM_TYPE_MARKERS)) return false;
  if (value.custom !== undefined && (!Array.isArray(value.custom) || !value.custom.every(isCustomParameter))) return false;
  return true;
}

function normalizeChoice<T extends readonly string[]>(value: unknown, values: T, fallback: T[number]): T[number] {
  return typeof value === "string" && values.includes(value) ? value : fallback;
}

function normalizeNumberChoice<T extends readonly number[]>(value: unknown, values: T, fallback: T[number]): T[number] {
  return typeof value === "number" && values.includes(value) ? value : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeParamTypes(value: unknown, fallback: SqlFormatterParamTypes | null): SqlFormatterParamTypes | null {
  if (value === null) return null;
  if (!isSqlFormatterParamTypes(value)) return fallback;
  return {
    ...(value.positional !== undefined ? { positional: value.positional } : {}),
    ...(value.numbered ? { numbered: [...value.numbered] } : {}),
    ...(value.named ? { named: [...value.named] } : {}),
    ...(value.quoted ? { quoted: [...value.quoted] } : {}),
    ...(value.custom ? { custom: value.custom.map((item) => ({ regex: item.regex })) } : {}),
  };
}

function cloneShortcuts(shortcuts: readonly SqlFormatterEditorShortcut[]): SqlFormatterEditorShortcut[] {
  return shortcuts.map((shortcut) => ({
    id: shortcut.id,
    action: shortcut.action,
    keys: { ...shortcut.keys },
    enabled: shortcut.enabled,
  }));
}

function normalizeShortcutKeys(value: unknown, fallback: SqlFormatterEditorShortcutKeys): SqlFormatterEditorShortcutKeys {
  const input = isObject(value) ? value : {};
  return {
    windows: typeof input.windows === "string" ? input.windows.trim() : fallback.windows,
    linux: typeof input.linux === "string" ? input.linux.trim() : fallback.linux,
    macos: typeof input.macos === "string" ? input.macos.trim() : fallback.macos,
  };
}

function isCompatibleShortcutAction(shortcut: Record<string, unknown>, fallback: SqlFormatterEditorShortcut): boolean {
  if (shortcut.action === undefined || shortcut.action === fallback.action || shortcut.action === fallback.id) return true;
  return fallback.id === "replace" && shortcut.action === "openReplacePanel";
}

export function sqlFormatterPlatformFromNavigator(platform = globalThis.navigator?.platform || ""): SqlFormatterPlatform {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return "macos";
  if (normalized.includes("linux")) return "linux";
  return "windows";
}

function keyPartToCodeMirror(part: string): string | null {
  const normalized = part.trim().toLowerCase();
  if (normalized === "ctrl" || normalized === "control") return "Ctrl";
  if (normalized === "cmd" || normalized === "command") return "Mod";
  if (normalized === "option" || normalized === "alt") return "Alt";
  if (normalized === "shift") return "Shift";
  if (normalized === "up") return "ArrowUp";
  if (normalized === "down") return "ArrowDown";
  if (normalized === "left") return "ArrowLeft";
  if (normalized === "right") return "ArrowRight";
  if (normalized === "esc") return "Escape";
  if (normalized === "enter" || normalized === "return") return "Enter";
  if (normalized === "del") return "Delete";
  if (normalized === "space") return "Space";
  if (normalized === "pageup") return "PageUp";
  if (normalized === "pagedown") return "PageDown";
  if (["tab", "escape", "backspace", "delete", "home", "end"].includes(normalized)) return normalized[0].toUpperCase() + normalized.slice(1);
  if (/^f(?:[1-9]|1\d|2[0-4])$/.test(normalized)) return normalized.toUpperCase();
  if (/^[a-z0-9]$/.test(normalized)) return normalized;
  return null;
}

export function sqlFormatterShortcutDisplayKeyToCodeMirrorKey(value: string): string | null {
  const parts = value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return null;

  const converted = parts.map(keyPartToCodeMirror);
  if (converted.some((part) => !part)) return null;

  const key = converted[converted.length - 1];
  if (!key || ["Ctrl", "Mod", "Alt", "Shift"].includes(key)) return null;

  const modifiers = converted.slice(0, -1);
  if (new Set(modifiers).size !== modifiers.length) return null;
  if (modifiers.some((part) => part && !["Ctrl", "Mod", "Alt", "Shift"].includes(part))) return null;

  return [...modifiers, key].join("-");
}

function shortcutConflictKey(value: string): string | null {
  return sqlFormatterShortcutDisplayKeyToCodeMirrorKey(value)?.toLowerCase() ?? null;
}

export function validateSqlFormatterEditorSettings(value: unknown): SqlFormatterEditorValidationResult {
  const settings = normalizeSqlFormatterEditorSettings(value);
  const platformSet = new Set(settings.platforms);

  for (const shortcut of settings.shortcuts) {
    if (!shortcut.enabled) continue;
    for (const platform of settings.platforms) {
      if (!shortcutConflictKey(shortcut.keys[platform])) return { ok: false, message: `Invalid editor shortcut value: ${shortcut.id}.` };
    }
  }

  for (const platform of SQL_FORMATTER_PLATFORM_VALUES) {
    if (!platformSet.has(platform)) continue;
    const seen = new Map<string, SqlFormatterEditorShortcutId>();
    for (const shortcut of settings.shortcuts) {
      if (!shortcut.enabled) continue;
      const key = shortcutConflictKey(shortcut.keys[platform]);
      if (!key) continue;
      const existing = seen.get(key);
      if (existing) return { ok: false, message: `Duplicate editor shortcut: ${platform}:${shortcut.keys[platform]}.` };
      seen.set(key, shortcut.id);
    }
  }

  return { ok: true };
}

export function normalizeSqlFormatterEditorSettings(value: unknown): SqlFormatterEditorSettings {
  const input = isObject(value) ? value : {};
  const shortcutsInput = Array.isArray(input.shortcuts) ? input.shortcuts.filter(isObject) : [];
  const platforms = Array.isArray(input.platforms) ? input.platforms.filter((platform): platform is SqlFormatterPlatform => isStringChoice(platform, SQL_FORMATTER_PLATFORM_VALUES)) : [...SQL_FORMATTER_PLATFORM_VALUES];
  const normalizedPlatforms = platforms.length ? [...new Set(platforms)] : [...SQL_FORMATTER_PLATFORM_VALUES];

  return {
    scope: SQL_FORMATTER_EDITOR_SCOPE,
    platforms: normalizedPlatforms,
    shortcuts: DEFAULT_SQL_FORMATTER_EDITOR_SHORTCUTS.map((fallback) => {
      const source = shortcutsInput.find((shortcut) => shortcut.id === fallback.id);
      return {
        id: fallback.id,
        action: fallback.action,
        keys: normalizeShortcutKeys(source?.keys, fallback.keys),
        enabled: typeof source?.enabled === "boolean" ? source.enabled : fallback.enabled,
      };
    }),
  };
}

function validateEditorConfig(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isObject(value)) return "Config editor must be a JSON object.";
  if (value.scope !== undefined && value.scope !== SQL_FORMATTER_EDITOR_SCOPE) return "Unsupported editor scope.";
  if (value.platforms !== undefined && (!Array.isArray(value.platforms) || !value.platforms.every((platform) => isStringChoice(platform, SQL_FORMATTER_PLATFORM_VALUES)))) {
    return "Invalid editor platforms.";
  }
  if (value.shortcuts === undefined) return null;
  if (!Array.isArray(value.shortcuts)) return "Config editor shortcuts must be an array.";

  for (const shortcut of value.shortcuts) {
    if (!isObject(shortcut) || typeof shortcut.id !== "string") return "Invalid editor shortcut value.";
    const fallback = DEFAULT_SQL_FORMATTER_EDITOR_SHORTCUTS.find((item) => item.id === shortcut.id);
    if (!fallback) return `Unknown editor shortcut: ${shortcut.id}.`;
    if (!isCompatibleShortcutAction(shortcut, fallback)) return `Invalid editor shortcut value: ${shortcut.id}.`;
    if (shortcut.enabled !== undefined && typeof shortcut.enabled !== "boolean") return `Invalid editor shortcut value: ${shortcut.id}.`;
    if (shortcut.keys !== undefined) {
      if (!isObject(shortcut.keys)) return `Invalid editor shortcut value: ${shortcut.id}.`;
      const keys = Object.entries(shortcut.keys);
      const hasInvalidKey = keys.some(([platform, key]) => !isStringChoice(platform, SQL_FORMATTER_PLATFORM_VALUES) || typeof key !== "string" || !key.trim());
      if (hasInvalidKey) {
        return `Invalid editor shortcut value: ${shortcut.id}.`;
      }
    }
  }

  const normalized = normalizeSqlFormatterEditorSettings(value);
  const validation = validateSqlFormatterEditorSettings(normalized);
  return validation.ok ? null : validation.message;
}

export function sqlFormatterOptionSettings(settings: unknown): SqlFormatterOptionSettings {
  const input = isObject(settings) ? settings : {};
  return {
    keywordCase: normalizeChoice(input.keywordCase, CASE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.keywordCase),
    dataTypeCase: normalizeChoice(input.dataTypeCase, CASE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.dataTypeCase),
    functionCase: normalizeChoice(input.functionCase, CASE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.functionCase),
    identifierCase: normalizeChoice(input.identifierCase, CASE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.identifierCase),
    indentStyle: normalizeChoice(input.indentStyle, INDENT_STYLE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.indentStyle),
    useTabs: normalizeBoolean(input.useTabs, DEFAULT_SQL_FORMATTER_SETTINGS.useTabs),
    tabWidth: normalizeNumberChoice(input.tabWidth, TAB_WIDTH_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.tabWidth),
    logicalOperatorNewline: normalizeChoice(input.logicalOperatorNewline, LOGICAL_OPERATOR_NEWLINE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.logicalOperatorNewline),
    expressionWidth: normalizeNumberChoice(input.expressionWidth, EXPRESSION_WIDTH_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.expressionWidth),
    linesBetweenQueries: normalizeNumberChoice(input.linesBetweenQueries, LINES_BETWEEN_QUERIES_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.linesBetweenQueries),
    denseOperators: normalizeBoolean(input.denseOperators, DEFAULT_SQL_FORMATTER_SETTINGS.denseOperators),
    newlineBeforeSemicolon: normalizeBoolean(input.newlineBeforeSemicolon, DEFAULT_SQL_FORMATTER_SETTINGS.newlineBeforeSemicolon),
    paramTypes: normalizeParamTypes(input.paramTypes, DEFAULT_SQL_FORMATTER_SETTINGS.paramTypes),
  };
}

export function normalizeSqlFormatterSettings(value: unknown): SqlFormatterSettings {
  const input = isObject(value) ? value : {};
  const optionSource = isObject(input.options) ? input.options : input;
  return {
    ...sqlFormatterOptionSettings(optionSource),
    editor: normalizeSqlFormatterEditorSettings(input.editor),
  };
}

export function sqlFormatterConfigFile(settings: unknown): SqlFormatterConfigFile {
  const normalized = normalizeSqlFormatterSettings(settings);
  return {
    version: SQL_FORMATTER_CONFIG_VERSION,
    formatter: SQL_FORMATTER_CONFIG_FORMATTER,
    options: sqlFormatterOptionSettings(normalized),
    editor: normalizeSqlFormatterEditorSettings(normalized.editor),
  };
}

export function serializeSqlFormatterConfig(settings: unknown): string {
  return JSON.stringify(sqlFormatterConfigFile(settings), null, 2);
}

export function parseSqlFormatterConfig(text: string): SqlFormatterConfigParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: "Invalid JSON." };
  }

  if (!isObject(parsed)) return { ok: false, message: "Config must be a JSON object." };
  if (parsed.version !== SQL_FORMATTER_CONFIG_VERSION) return { ok: false, message: "Unsupported config version." };
  if (parsed.formatter !== SQL_FORMATTER_CONFIG_FORMATTER) return { ok: false, message: "Unsupported formatter." };
  if (!isObject(parsed.options)) return { ok: false, message: "Config options must be a JSON object." };

  const unknownOption = Object.keys(parsed.options).find((key) => !SQL_FORMATTER_OPTION_KEYS.has(key as keyof SqlFormatterOptionSettings) && !SQL_FORMATTER_LEGACY_OPTION_KEYS.has(key));
  if (unknownOption) return { ok: false, message: `Unknown formatter option: ${unknownOption}.` };
  if ("params" in parsed.options && parsed.options.params !== null) return { ok: false, message: "Unsupported formatter option: params." };

  const invalidOption = Object.entries(parsed.options).find(([key, value]) => {
    if (SQL_FORMATTER_LEGACY_OPTION_KEYS.has(key)) return false;
    const optionKey = key as keyof SqlFormatterOptionSettings;
    return !SQL_FORMATTER_OPTION_VALIDATORS[optionKey](value);
  });
  if (invalidOption) return { ok: false, message: `Invalid formatter option value: ${invalidOption[0]}.` };

  const editorError = validateEditorConfig(parsed.editor);
  if (editorError) return { ok: false, message: editorError };

  return { ok: true, settings: normalizeSqlFormatterSettings({ ...parsed.options, editor: parsed.editor }) };
}

export function syncSqlFormatterConfigDraft(text: string, syncSettings: (settings: SqlFormatterSettings) => void): SqlFormatterConfigParseResult {
  const result = parseSqlFormatterConfig(text);
  if (result.ok) syncSettings(result.settings);
  return result;
}

export function sqlFormatterOptions(settings: unknown) {
  const normalized = sqlFormatterOptionSettings(settings);
  return {
    keywordCase: normalized.keywordCase,
    dataTypeCase: normalized.dataTypeCase,
    functionCase: normalized.functionCase,
    identifierCase: normalized.identifierCase,
    indentStyle: normalized.indentStyle,
    useTabs: normalized.useTabs,
    tabWidth: normalized.tabWidth,
    logicalOperatorNewline: normalized.logicalOperatorNewline,
    expressionWidth: normalized.expressionWidth,
    linesBetweenQueries: normalized.linesBetweenQueries,
    denseOperators: normalized.denseOperators,
    newlineBeforeSemicolon: normalized.newlineBeforeSemicolon,
    ...(normalized.paramTypes !== null ? { paramTypes: normalized.paramTypes } : {}),
  };
}
