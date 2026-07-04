export const SQL_FORMATTER_CONFIG_VERSION = 1;
export const SQL_FORMATTER_CONFIG_FORMATTER = "sql-formatter";

const CASE_VALUES = ["preserve", "upper", "lower"] as const;
const INDENT_STYLE_VALUES = ["standard", "tabularLeft", "tabularRight"] as const;
const LOGICAL_OPERATOR_NEWLINE_VALUES = ["before", "after"] as const;
const TAB_WIDTH_VALUES = [2, 4] as const;
const EXPRESSION_WIDTH_VALUES = [50, 80, 120] as const;
const LINES_BETWEEN_QUERIES_VALUES = [0, 1, 2] as const;
const SQL_FORMATTER_PARAM_TYPE_MARKERS = ["?", ":", "$"] as const;
const SQL_FORMATTER_NAMED_PARAM_TYPE_MARKERS = [":", "@", "$"] as const;
const SQL_FORMATTER_LEGACY_OPTION_KEYS = new Set(["params"]);

export type SqlFormatterCase = (typeof CASE_VALUES)[number];
export type SqlFormatterIndentStyle = (typeof INDENT_STYLE_VALUES)[number];
export type SqlFormatterLogicalOperatorNewline = (typeof LOGICAL_OPERATOR_NEWLINE_VALUES)[number];
export type SqlFormatterTabWidth = (typeof TAB_WIDTH_VALUES)[number];
export type SqlFormatterExpressionWidth = (typeof EXPRESSION_WIDTH_VALUES)[number];
export type SqlFormatterLinesBetweenQueries = (typeof LINES_BETWEEN_QUERIES_VALUES)[number];

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

export type SqlFormatterSettings = SqlFormatterOptionSettings;

export interface SqlFormatterConfigFile {
  version: typeof SQL_FORMATTER_CONFIG_VERSION;
  formatter: typeof SQL_FORMATTER_CONFIG_FORMATTER;
  options: SqlFormatterOptionSettings;
}

export type SqlFormatterConfigParseResult = { ok: true; settings: SqlFormatterSettings } | { ok: false; message: string };

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
  return sqlFormatterOptionSettings(optionSource);
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

  return { ok: true, settings: normalizeSqlFormatterSettings(parsed.options) };
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
