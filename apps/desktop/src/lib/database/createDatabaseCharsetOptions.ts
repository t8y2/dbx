type QueryLikeResult = {
  columns: string[];
  rows: (string | number | boolean | null)[][];
};

export interface CreateDatabaseCharsetMetadata {
  charsets: string[];
  collationsByCharset: Record<string, string[]>;
}

export const CREATE_DATABASE_CHARSET_OPTIONS = ["utf8mb4", "utf8", "gbk", "latin1", "ascii", "big5", "gb2312", "utf16", "utf32"] as const;

const FALLBACK_COLLATION_OPTIONS: Record<string, string[]> = {
  ascii: ["ascii_general_ci", "ascii_bin"],
  big5: ["big5_chinese_ci", "big5_bin"],
  gb2312: ["gb2312_chinese_ci", "gb2312_bin"],
  gbk: ["gbk_chinese_ci", "gbk_bin"],
  latin1: ["latin1_swedish_ci", "latin1_general_ci", "latin1_bin"],
  utf16: ["utf16_general_ci", "utf16_unicode_ci", "utf16_bin"],
  utf32: ["utf32_general_ci", "utf32_unicode_ci", "utf32_bin"],
  utf8: ["utf8mb3_general_ci", "utf8mb3_unicode_ci", "utf8mb3_bin"],
  utf8mb3: ["utf8mb3_general_ci", "utf8mb3_unicode_ci", "utf8mb3_bin"],
  utf8mb4: ["utf8mb4_unicode_ci", "utf8mb4_general_ci", "utf8mb4_bin"],
};

export function normalizeCreateDatabaseCharset(value: string): string {
  return value.trim();
}

export function normalizeCreateDatabaseCharsetKey(value: string): string {
  const normalized = normalizeCreateDatabaseCharset(value).toLowerCase();
  return normalized === "utf8" ? "utf8mb3" : normalized;
}

export function createDatabaseCollationOptionsForCharset(charset: string, collationsByCharset: Record<string, string[]> = FALLBACK_COLLATION_OPTIONS): string[] {
  return collationsByCharset[normalizeCreateDatabaseCharsetKey(charset)] ?? [];
}

export function defaultCreateDatabaseCollationForCharset(charset: string, collationsByCharset: Record<string, string[]> = FALLBACK_COLLATION_OPTIONS): string {
  return createDatabaseCollationOptionsForCharset(charset, collationsByCharset)[0] ?? "";
}

export function nextCreateDatabaseCollation(nextCharset: string, previousCharset: string, currentCollation: string, collationsByCharset: Record<string, string[]> = FALLBACK_COLLATION_OPTIONS): string {
  const previousDefault = defaultCreateDatabaseCollationForCharset(previousCharset, collationsByCharset);
  if (currentCollation && currentCollation !== previousDefault) return currentCollation;
  return defaultCreateDatabaseCollationForCharset(nextCharset, collationsByCharset) || currentCollation;
}

export function fallbackCreateDatabaseCharsetMetadata(): CreateDatabaseCharsetMetadata {
  return {
    charsets: [...CREATE_DATABASE_CHARSET_OPTIONS],
    collationsByCharset: { ...FALLBACK_COLLATION_OPTIONS },
  };
}

export function parseCreateDatabaseCharsetMetadata(charsetResult: QueryLikeResult, collationResult: QueryLikeResult): CreateDatabaseCharsetMetadata {
  const charsetNameIndex = columnIndex(charsetResult.columns, ["charset", "character set", "character_set_name"]);
  const charsetDefaultCollationIndex = columnIndex(charsetResult.columns, ["default collation", "default_collate_name", "default_collation_name"]);
  const collationNameIndex = columnIndex(collationResult.columns, ["collation", "collation_name"]);
  const collationCharsetIndex = columnIndex(collationResult.columns, ["charset", "character_set_name"]);
  const collationDefaultIndex = columnIndex(collationResult.columns, ["default", "is_default"]);

  const charsets = uniqueStrings(charsetResult.rows.map((row) => cellString(row[charsetNameIndex])));
  const collationsByCharset: Record<string, string[]> = {};

  for (const row of collationResult.rows) {
    const collation = cellString(row[collationNameIndex]);
    const charset = normalizeCreateDatabaseCharsetKey(cellString(row[collationCharsetIndex]));
    if (!collation || !charset || isHiddenCreateDatabaseCollation(collation)) continue;
    collationsByCharset[charset] ??= [];
    if (isDefaultFlag(row[collationDefaultIndex])) {
      collationsByCharset[charset].unshift(collation);
    } else if (!collationsByCharset[charset].includes(collation)) {
      collationsByCharset[charset].push(collation);
    }
  }

  for (const row of charsetResult.rows) {
    const charset = normalizeCreateDatabaseCharsetKey(cellString(row[charsetNameIndex]));
    const defaultCollation = cellString(row[charsetDefaultCollationIndex]);
    if (!charset || !defaultCollation || isHiddenCreateDatabaseCollation(defaultCollation)) continue;
    collationsByCharset[charset] ??= [];
    const existingIndex = collationsByCharset[charset].indexOf(defaultCollation);
    if (existingIndex > 0) collationsByCharset[charset].splice(existingIndex, 1);
    if (existingIndex !== 0) collationsByCharset[charset].unshift(defaultCollation);
  }

  return {
    charsets: charsets.length ? charsets : [...CREATE_DATABASE_CHARSET_OPTIONS],
    collationsByCharset: Object.keys(collationsByCharset).length ? collationsByCharset : { ...FALLBACK_COLLATION_OPTIONS },
  };
}

function columnIndex(columns: string[], names: string[]): number {
  const lowerNames = names.map((name) => name.toLowerCase());
  const index = columns.findIndex((column) => lowerNames.includes(column.trim().toLowerCase()));
  return index >= 0 ? index : 0;
}

function cellString(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isHiddenCreateDatabaseCollation(value: string): boolean {
  return value.toLowerCase().includes("_0900_");
}

function isDefaultFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["yes", "y", "1", "true"].includes(value.trim().toLowerCase());
}
