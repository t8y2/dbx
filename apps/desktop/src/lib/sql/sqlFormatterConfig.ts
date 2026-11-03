export const SQL_FORMATTER_CONFIG_VERSION = 2;
export const SQL_FORMATTER_CONFIG_FORMATTER = "sql-formatter";

// Version 1 shipped from v0.5.52 through v0.6.37 and predates `commaPosition`
// and `layoutStyle`, so it must keep parsing: a file is a record of the user's
// options, and rejecting it would silently discard their whole config.
const SQL_FORMATTER_CONFIG_VERSIONS = new Set([1, 2]);

const CASE_VALUES = ["preserve", "upper", "lower"] as const;
const INDENT_STYLE_VALUES = ["standard", "tabularLeft", "tabularRight"] as const;
const LAYOUT_STYLE_VALUES = ["dbx", "classic"] as const;
const LOGICAL_OPERATOR_NEWLINE_VALUES = ["before", "after", "none"] as const;
const COMMA_POSITION_VALUES = ["after", "before"] as const;
const FROM_CLAUSE_LAYOUT_VALUES = ["newLine", "sameLine"] as const;
const TAB_WIDTH_VALUES = [2, 4] as const;
const LINES_BETWEEN_QUERIES_VALUES = [0, 1, 2] as const;
const LIST_LAYOUT_VALUES = ["singleLine", "fit", "vertical", "wrap"] as const;
const LIST_LAYOUT_OVERRIDE_VALUES = ["inherit", ...LIST_LAYOUT_VALUES] as const;
const COMMA_OVERRIDE_VALUES = ["inherit", ...COMMA_POSITION_VALUES] as const;
const LOGICAL_OVERRIDE_VALUES = ["inherit", ...LOGICAL_OPERATOR_NEWLINE_VALUES] as const;
const LIST_ALIGNMENT_VALUES = ["firstItem", "indent"] as const;
const EMPTY_LINE_MODE_VALUES = ["inherit", "remove", "single", "preserve"] as const;
const SQL_FORMATTER_PARAM_TYPE_MARKERS = ["?", ":", "$"] as const;
const SQL_FORMATTER_NAMED_PARAM_TYPE_MARKERS = [":", "@", "$"] as const;
const SQL_FORMATTER_LEGACY_OPTION_KEYS = new Set(["params"]);

export type SqlFormatterCase = (typeof CASE_VALUES)[number];
export type SqlFormatterIndentStyle = (typeof INDENT_STYLE_VALUES)[number];
export type SqlFormatterLayoutStyle = (typeof LAYOUT_STYLE_VALUES)[number];
export type SqlFormatterLogicalOperatorNewline = (typeof LOGICAL_OPERATOR_NEWLINE_VALUES)[number];
export type SqlFormatterCommaPosition = (typeof COMMA_POSITION_VALUES)[number];
export type SqlFormatterFromClauseLayout = (typeof FROM_CLAUSE_LAYOUT_VALUES)[number];
export type SqlFormatterTabWidth = (typeof TAB_WIDTH_VALUES)[number];
export type SqlFormatterExpressionWidth = number;
export type SqlFormatterLinesBetweenQueries = (typeof LINES_BETWEEN_QUERIES_VALUES)[number];
export type SqlFormatterListLayout = (typeof LIST_LAYOUT_VALUES)[number];
export type SqlFormatterListLayoutOverride = (typeof LIST_LAYOUT_OVERRIDE_VALUES)[number];
export type SqlFormatterCommaOverride = (typeof COMMA_OVERRIDE_VALUES)[number];
export type SqlFormatterLogicalOverride = (typeof LOGICAL_OVERRIDE_VALUES)[number];
export type SqlFormatterListAlignment = (typeof LIST_ALIGNMENT_VALUES)[number];
export type SqlFormatterEmptyLineMode = (typeof EMPTY_LINE_MODE_VALUES)[number];

export interface SqlFormatterRuleSettings {
  customRulesEnabled: boolean;
  listLayout: SqlFormatterListLayout;
  selectListLayout: SqlFormatterListLayoutOverride;
  insertListLayout: SqlFormatterListLayoutOverride;
  updateListLayout: SqlFormatterListLayoutOverride;
  listItemAlignment: SqlFormatterListAlignment;
  alignSelectAliases: boolean;
  alignUpdateAssignments: boolean;
  selectCommaPosition: SqlFormatterCommaOverride;
  insertCommaPosition: SqlFormatterCommaOverride;
  updateCommaPosition: SqlFormatterCommaOverride;
  whereLogicalOperatorNewline: SqlFormatterLogicalOverride;
  onLogicalOperatorNewline: SqlFormatterLogicalOverride;
  expressionLogicalOperatorNewline: SqlFormatterLogicalOverride;
  newlineBeforeJoinOn: boolean;
  collapseShortStatements: boolean;
  emptyLineMode: SqlFormatterEmptyLineMode;
}

export const DEFAULT_SQL_FORMATTER_RULE_SETTINGS: SqlFormatterRuleSettings = {
  customRulesEnabled: false,
  listLayout: "fit",
  selectListLayout: "vertical",
  insertListLayout: "fit",
  updateListLayout: "fit",
  listItemAlignment: "firstItem",
  alignSelectAliases: true,
  alignUpdateAssignments: false,
  selectCommaPosition: "inherit",
  insertCommaPosition: "inherit",
  updateCommaPosition: "inherit",
  whereLogicalOperatorNewline: "inherit",
  onLogicalOperatorNewline: "inherit",
  expressionLogicalOperatorNewline: "inherit",
  newlineBeforeJoinOn: false,
  collapseShortStatements: true,
  emptyLineMode: "inherit",
};

export interface SqlFormatterCustomParameter {
  regex: string;
}

// DBX substitutes `${name}`/`#{name}` placeholders client-side (see sqlVariableSyntax.ts),
// but no sql-formatter dialect tokenizes them, so raw SQL containing them would fail to
// format with a parse error. Always registering them as custom params keeps formatting working.
const DBX_CUSTOM_PARAM_TYPES: SqlFormatterCustomParameter[] = [{ regex: String.raw`\$\{[^}]+\}` }, { regex: String.raw`#\{[^}]+\}` }];

export interface SqlFormatterParamTypes {
  positional?: boolean;
  numbered?: ("?" | ":" | "$")[];
  named?: (":" | "@" | "$")[];
  quoted?: (":" | "@" | "$")[];
  custom?: SqlFormatterCustomParameter[];
}

export interface SqlFormatterOptionSettings extends SqlFormatterRuleSettings {
  // DBX-private: selects which layout engine runs and never reaches
  // sql-formatter itself (see sqlFormatterOptions).
  layoutStyle: SqlFormatterLayoutStyle;
  keywordCase: SqlFormatterCase;
  dataTypeCase: SqlFormatterCase;
  functionCase: SqlFormatterCase;
  identifierCase: SqlFormatterCase;
  indentStyle: SqlFormatterIndentStyle;
  useTabs: boolean;
  tabWidth: SqlFormatterTabWidth;
  logicalOperatorNewline: SqlFormatterLogicalOperatorNewline;
  commaPosition: SqlFormatterCommaPosition;
  fromClauseLayout: SqlFormatterFromClauseLayout;
  expressionWidth: SqlFormatterExpressionWidth;
  linesBetweenQueries: SqlFormatterLinesBetweenQueries;
  preserveEmptyLines: boolean;
  denseOperators: boolean;
  newlineBeforeSemicolon: boolean;
  paramTypes: SqlFormatterParamTypes | null;
}

export type SqlFormatterSettings = SqlFormatterOptionSettings;

export interface SqlFormatterConfigFile {
  version: typeof SQL_FORMATTER_CONFIG_VERSION;
  formatter: typeof SQL_FORMATTER_CONFIG_FORMATTER;
  options: SqlFormatterOptionSettings;
}

export type SqlFormatterConfigParseResult = { ok: true; settings: SqlFormatterSettings } | { ok: false; message: string };

export const DEFAULT_SQL_FORMATTER_SETTINGS: SqlFormatterSettings = {
  ...DEFAULT_SQL_FORMATTER_RULE_SETTINGS,
  layoutStyle: "dbx",
  keywordCase: "upper",
  dataTypeCase: "preserve",
  functionCase: "preserve",
  identifierCase: "preserve",
  indentStyle: "standard",
  useTabs: false,
  tabWidth: 2,
  logicalOperatorNewline: "before",
  commaPosition: "after",
  fromClauseLayout: "sameLine",
  expressionWidth: 120,
  linesBetweenQueries: 1,
  preserveEmptyLines: false,
  denseOperators: false,
  newlineBeforeSemicolon: false,
  paramTypes: null,
};

// A new key is not done when it is added here: an older settings export
// legitimately lacks it, so it must also be registered in
// `SQL_FORMATTER_KEYS_ADDED_AFTER_TRANSFER_FORMAT`
// (lib/settings/settingsTransfer.ts) or every pre-existing `dbx-settings-*.json`
// stops importing wholesale, and given a row in the `expectedControls` list of
// lib/settings/__tests__/settingsSearch.spec.ts so its search entry stays pinned.
const SQL_FORMATTER_OPTION_KEYS = new Set<keyof SqlFormatterOptionSettings>([
  ...(Object.keys(DEFAULT_SQL_FORMATTER_RULE_SETTINGS) as (keyof SqlFormatterRuleSettings)[]),
  "layoutStyle",
  "keywordCase",
  "dataTypeCase",
  "functionCase",
  "identifierCase",
  "indentStyle",
  "useTabs",
  "tabWidth",
  "logicalOperatorNewline",
  "commaPosition",
  "fromClauseLayout",
  "expressionWidth",
  "linesBetweenQueries",
  "preserveEmptyLines",
  "denseOperators",
  "newlineBeforeSemicolon",
  "paramTypes",
]);

const SQL_FORMATTER_OPTION_VALIDATORS: Record<keyof SqlFormatterOptionSettings, (value: unknown) => boolean> = {
  customRulesEnabled: (value) => typeof value === "boolean",
  listLayout: (value) => isStringChoice(value, LIST_LAYOUT_VALUES),
  selectListLayout: (value) => isStringChoice(value, LIST_LAYOUT_OVERRIDE_VALUES),
  insertListLayout: (value) => isStringChoice(value, LIST_LAYOUT_OVERRIDE_VALUES),
  updateListLayout: (value) => isStringChoice(value, LIST_LAYOUT_OVERRIDE_VALUES),
  listItemAlignment: (value) => isStringChoice(value, LIST_ALIGNMENT_VALUES),
  alignSelectAliases: (value) => typeof value === "boolean",
  alignUpdateAssignments: (value) => typeof value === "boolean",
  selectCommaPosition: (value) => isStringChoice(value, COMMA_OVERRIDE_VALUES),
  insertCommaPosition: (value) => isStringChoice(value, COMMA_OVERRIDE_VALUES),
  updateCommaPosition: (value) => isStringChoice(value, COMMA_OVERRIDE_VALUES),
  whereLogicalOperatorNewline: (value) => isStringChoice(value, LOGICAL_OVERRIDE_VALUES),
  onLogicalOperatorNewline: (value) => isStringChoice(value, LOGICAL_OVERRIDE_VALUES),
  expressionLogicalOperatorNewline: (value) => isStringChoice(value, LOGICAL_OVERRIDE_VALUES),
  newlineBeforeJoinOn: (value) => typeof value === "boolean",
  collapseShortStatements: (value) => typeof value === "boolean",
  emptyLineMode: (value) => isStringChoice(value, EMPTY_LINE_MODE_VALUES),
  layoutStyle: (value) => isStringChoice(value, LAYOUT_STYLE_VALUES),
  keywordCase: (value) => isStringChoice(value, CASE_VALUES),
  dataTypeCase: (value) => isStringChoice(value, CASE_VALUES),
  functionCase: (value) => isStringChoice(value, CASE_VALUES),
  identifierCase: (value) => isStringChoice(value, CASE_VALUES),
  indentStyle: (value) => isStringChoice(value, INDENT_STYLE_VALUES),
  useTabs: (value) => typeof value === "boolean",
  tabWidth: (value) => isNumberChoice(value, TAB_WIDTH_VALUES),
  logicalOperatorNewline: (value) => isStringChoice(value, LOGICAL_OPERATOR_NEWLINE_VALUES),
  commaPosition: (value) => isStringChoice(value, COMMA_POSITION_VALUES),
  fromClauseLayout: (value) => isStringChoice(value, FROM_CLAUSE_LAYOUT_VALUES),
  expressionWidth: isExpressionWidth,
  linesBetweenQueries: (value) => isNumberChoice(value, LINES_BETWEEN_QUERIES_VALUES),
  preserveEmptyLines: (value) => typeof value === "boolean",
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

function isExpressionWidth(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 20 && value <= 500;
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

export function sqlFormatterOptionSettings(settings: unknown): SqlFormatterOptionSettings {
  const input = isObject(settings) ? settings : {};
  return {
    customRulesEnabled: normalizeBoolean(input.customRulesEnabled, DEFAULT_SQL_FORMATTER_SETTINGS.customRulesEnabled),
    listLayout: normalizeChoice(input.listLayout, LIST_LAYOUT_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.listLayout),
    selectListLayout: normalizeChoice(input.selectListLayout, LIST_LAYOUT_OVERRIDE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.selectListLayout),
    insertListLayout: normalizeChoice(input.insertListLayout, LIST_LAYOUT_OVERRIDE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.insertListLayout),
    updateListLayout: normalizeChoice(input.updateListLayout, LIST_LAYOUT_OVERRIDE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.updateListLayout),
    listItemAlignment: normalizeChoice(input.listItemAlignment, LIST_ALIGNMENT_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.listItemAlignment),
    alignSelectAliases: normalizeBoolean(input.alignSelectAliases, DEFAULT_SQL_FORMATTER_SETTINGS.alignSelectAliases),
    alignUpdateAssignments: normalizeBoolean(input.alignUpdateAssignments, DEFAULT_SQL_FORMATTER_SETTINGS.alignUpdateAssignments),
    selectCommaPosition: normalizeChoice(input.selectCommaPosition, COMMA_OVERRIDE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.selectCommaPosition),
    insertCommaPosition: normalizeChoice(input.insertCommaPosition, COMMA_OVERRIDE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.insertCommaPosition),
    updateCommaPosition: normalizeChoice(input.updateCommaPosition, COMMA_OVERRIDE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.updateCommaPosition),
    whereLogicalOperatorNewline: normalizeChoice(input.whereLogicalOperatorNewline, LOGICAL_OVERRIDE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.whereLogicalOperatorNewline),
    onLogicalOperatorNewline: normalizeChoice(input.onLogicalOperatorNewline, LOGICAL_OVERRIDE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.onLogicalOperatorNewline),
    expressionLogicalOperatorNewline: normalizeChoice(input.expressionLogicalOperatorNewline, LOGICAL_OVERRIDE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.expressionLogicalOperatorNewline),
    newlineBeforeJoinOn: normalizeBoolean(input.newlineBeforeJoinOn, DEFAULT_SQL_FORMATTER_SETTINGS.newlineBeforeJoinOn),
    collapseShortStatements: normalizeBoolean(input.collapseShortStatements, DEFAULT_SQL_FORMATTER_SETTINGS.collapseShortStatements),
    emptyLineMode: normalizeChoice(input.emptyLineMode, EMPTY_LINE_MODE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.emptyLineMode),
    layoutStyle: normalizeChoice(input.layoutStyle, LAYOUT_STYLE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.layoutStyle),
    keywordCase: normalizeChoice(input.keywordCase, CASE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.keywordCase),
    dataTypeCase: normalizeChoice(input.dataTypeCase, CASE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.dataTypeCase),
    functionCase: normalizeChoice(input.functionCase, CASE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.functionCase),
    identifierCase: normalizeChoice(input.identifierCase, CASE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.identifierCase),
    indentStyle: normalizeChoice(input.indentStyle, INDENT_STYLE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.indentStyle),
    useTabs: normalizeBoolean(input.useTabs, DEFAULT_SQL_FORMATTER_SETTINGS.useTabs),
    tabWidth: normalizeNumberChoice(input.tabWidth, TAB_WIDTH_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.tabWidth),
    logicalOperatorNewline: normalizeChoice(input.logicalOperatorNewline, LOGICAL_OPERATOR_NEWLINE_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.logicalOperatorNewline),
    commaPosition: normalizeChoice(input.commaPosition, COMMA_POSITION_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.commaPosition),
    fromClauseLayout: normalizeChoice(input.fromClauseLayout, FROM_CLAUSE_LAYOUT_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.fromClauseLayout),
    expressionWidth: isExpressionWidth(input.expressionWidth) ? input.expressionWidth : DEFAULT_SQL_FORMATTER_SETTINGS.expressionWidth,
    linesBetweenQueries: normalizeNumberChoice(input.linesBetweenQueries, LINES_BETWEEN_QUERIES_VALUES, DEFAULT_SQL_FORMATTER_SETTINGS.linesBetweenQueries),
    preserveEmptyLines: normalizeBoolean(input.preserveEmptyLines, DEFAULT_SQL_FORMATTER_SETTINGS.preserveEmptyLines),
    denseOperators: normalizeBoolean(input.denseOperators, DEFAULT_SQL_FORMATTER_SETTINGS.denseOperators),
    newlineBeforeSemicolon: normalizeBoolean(input.newlineBeforeSemicolon, DEFAULT_SQL_FORMATTER_SETTINGS.newlineBeforeSemicolon),
    paramTypes: normalizeParamTypes(input.paramTypes, DEFAULT_SQL_FORMATTER_SETTINGS.paramTypes),
  };
}

export function normalizeSqlFormatterSettings(value: unknown): SqlFormatterSettings {
  const input = isObject(value) ? value : {};
  const optionSource = isObject(input.options) ? input.options : input;
  return sqlFormatterOptionSettings(optionSource);
}

/**
 * Complete nested-schema check for an already-shaped settings object: every
 * formatter option must be present with a valid value, and no unknown option
 * may appear. Unlike the normalizer this never fills defaults, so callers can
 * reject partially malformed payloads instead of silently substituting them.
 */
export function isCompleteSqlFormatterSettings(value: unknown): value is SqlFormatterSettings {
  if (!isObject(value)) return false;
  for (const key of SQL_FORMATTER_OPTION_KEYS) {
    if (!(key in value)) return false;
    if (!SQL_FORMATTER_OPTION_VALIDATORS[key]((value as Record<string, unknown>)[key])) return false;
  }
  return Object.keys(value).every((key) => SQL_FORMATTER_OPTION_KEYS.has(key as keyof SqlFormatterOptionSettings));
}

export function sqlFormatterConfigFile(settings: unknown): SqlFormatterConfigFile {
  const normalized = normalizeSqlFormatterSettings(settings);
  return {
    version: SQL_FORMATTER_CONFIG_VERSION,
    formatter: SQL_FORMATTER_CONFIG_FORMATTER,
    options: sqlFormatterOptionSettings(normalized),
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
  if (typeof parsed.version !== "number" || !SQL_FORMATTER_CONFIG_VERSIONS.has(parsed.version)) return { ok: false, message: "Unsupported config version." };
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

  return { ok: true, settings: normalizeSqlFormatterSettings(parsed.options) };
}

export function syncSqlFormatterConfigDraft(text: string, syncSettings: (settings: SqlFormatterSettings) => void): SqlFormatterConfigParseResult {
  const result = parseSqlFormatterConfig(text);
  if (result.ok) syncSettings(result.settings);
  return result;
}

export function sqlFormatterOptions(settings: unknown) {
  const normalized = sqlFormatterOptionSettings(settings);
  const paramTypes = normalized.paramTypes ?? {};
  return {
    keywordCase: normalized.keywordCase,
    dataTypeCase: normalized.dataTypeCase,
    functionCase: normalized.functionCase,
    identifierCase: normalized.identifierCase,
    indentStyle: normalized.indentStyle,
    useTabs: normalized.useTabs,
    tabWidth: normalized.tabWidth,
    // sql-formatter itself only supports before/after. The custom "none"
    // mode is applied as a post-processing pass by formatSqlText.
    logicalOperatorNewline: normalized.logicalOperatorNewline === "none" ? "before" : normalized.logicalOperatorNewline,
    expressionWidth: normalized.expressionWidth,
    linesBetweenQueries: normalized.linesBetweenQueries,
    denseOperators: normalized.denseOperators,
    newlineBeforeSemicolon: normalized.newlineBeforeSemicolon,
    paramTypes: {
      ...paramTypes,
      positional: paramTypes.positional ?? true,
      named: paramTypes.named ?? [":", "@"],
      custom: [...(paramTypes.custom ?? []), ...DBX_CUSTOM_PARAM_TYPES],
    },
  };
}
