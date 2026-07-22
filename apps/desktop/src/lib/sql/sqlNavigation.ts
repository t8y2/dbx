/**
 * Utilities for SQL identifier navigation (Ctrl/Cmd + click on table/column names).
 */

import type { ObjectSourceKind } from "@/types/database";

const SQL_KEYWORDS_SET = new Set([
  "select",
  "from",
  "where",
  "join",
  "left",
  "right",
  "inner",
  "outer",
  "on",
  "group",
  "by",
  "order",
  "asc",
  "desc",
  "having",
  "limit",
  "offset",
  "insert",
  "into",
  "values",
  "update",
  "set",
  "delete",
  "create",
  "table",
  "view",
  "as",
  "and",
  "or",
  "not",
  "in",
  "is",
  "null",
  "like",
  "distinct",
  "union",
  "all",
  "exists",
  "between",
  "case",
  "when",
  "then",
  "else",
  "end",
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "coalesce",
  "cast",
  "alter",
  "drop",
  "add",
  "column",
  "index",
  "primary",
  "key",
  "foreign",
  "references",
  "constraint",
  "default",
  "check",
  "unique",
  "begin",
  "commit",
  "rollback",
  "truncate",
  "explain",
  "analyze",
  "with",
  "recursive",
  "over",
  "partition",
  "row_number",
  "rank",
  "dense_rank",
  "lag",
  "lead",
  "first_value",
  "last_value",
  "ntile",
  "cross",
  "full",
  "natural",
  "using",
  "lateral",
  "unnest",
  "filter",
  "exclude",
  "replace",
  "qualify",
  "pivot",
  "unpivot",
  "asof",
  "positional",
  "anti",
  "semi",
  "sample",
  "struct",
  "map",
  "list",
  "array",
  "lambda",
  "copy",
  "export",
  "import",
  "describe",
  "show",
  "summarize",
  "pragma",
  "tablesample",
  "read_csv",
  "read_parquet",
  "read_json",
  "list_transform",
]);

type IdentifierPart = { value: string; start: number; end: number; quoted: boolean };

export interface ExtractedSqlIdentifier {
  identifier: string;
  quoted: boolean;
}

export interface ExtractedSqlIdentifierPart {
  value: string;
  quoted: boolean;
}

export type SqlObjectNavigationType = "table" | "view" | "materialized_view";

export interface SqlObjectNavigationTarget {
  name: string;
  database?: string;
  schema?: string;
  type?: SqlObjectNavigationType;
}

export function sqlObjectNavigationTarget(table: SqlObjectNavigationTarget): SqlObjectNavigationTarget {
  return {
    name: table.name,
    ...(table.database ? { database: table.database } : {}),
    ...(table.schema ? { schema: table.schema } : {}),
    ...(table.type ? { type: table.type } : {}),
  };
}

export function sqlObjectHoverDetail(table: SqlObjectNavigationTarget): string {
  const objectType = table.type === "materialized_view" ? "materialized view" : table.type === "view" ? "view" : "table";
  return table.schema ? `${objectType} in ${table.schema}` : objectType;
}

export function sqlObjectNavigationTableType(table: SqlObjectNavigationTarget): "TABLE" | "VIEW" | "MATERIALIZED_VIEW" {
  if (table.type === "materialized_view") return "MATERIALIZED_VIEW";
  return table.type === "view" ? "VIEW" : "TABLE";
}

export function sqlObjectNavigationSourceKind(table: SqlObjectNavigationTarget): ObjectSourceKind | undefined {
  const type = sqlObjectNavigationTableType(table);
  return type === "TABLE" ? undefined : type;
}

export function sqlObjectNavigationTypeFromTableType(tableType: string | null | undefined): SqlObjectNavigationType {
  const normalized = tableType
    ?.trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (normalized === "MATERIALIZED_VIEW") return "materialized_view";
  if (normalized === "VIEW") return "view";
  return "table";
}

export function mergeSqlObjectNavigationType(left?: SqlObjectNavigationType, right?: SqlObjectNavigationType): SqlObjectNavigationType | undefined {
  if (left === "materialized_view" || right === "materialized_view") return "materialized_view";
  if (left === "view" || right === "view") return "view";
  return left ?? right;
}

function isIdentifierChar(char: string | undefined): boolean {
  return !!char && /^[A-Za-z0-9_$]$/.test(char);
}

function readQuotedPart(text: string, start: number): IdentifierPart | null {
  const open = text[start];
  const close = open === "[" ? "]" : open;
  if (open !== "`" && open !== '"' && open !== "[") return null;

  let value = "";
  for (let i = start + 1; i < text.length; i += 1) {
    const char = text[i];
    if (char === close) {
      if (text[i + 1] === close) {
        value += close;
        i += 1;
        continue;
      }
      return { value, start, end: i + 1, quoted: true };
    }
    value += char;
  }
  return null;
}

function readUnquotedPart(text: string, start: number): IdentifierPart | null {
  if (!isIdentifierChar(text[start])) return null;
  let end = start + 1;
  while (end < text.length && isIdentifierChar(text[end])) end += 1;
  return { value: text.slice(start, end), start, end, quoted: false };
}

function readIdentifierPart(text: string, start: number): IdentifierPart | null {
  return readQuotedPart(text, start) ?? readUnquotedPart(text, start);
}

function parseQualifiedIdentifier(text: string, start: number): { parts: IdentifierPart[]; start: number; end: number } | null {
  const first = readIdentifierPart(text, start);
  if (!first) return null;

  const parts = [first];
  let end = first.end;
  while (text[end] === ".") {
    const next = readIdentifierPart(text, end + 1);
    if (!next) break;
    parts.push(next);
    end = next.end;
  }

  return { parts, start, end };
}

function identifierSearchBounds(doc: string, pos: number): { start: number; end: number } {
  let start = pos;
  while (start > 0 && doc[start - 1] !== "\n" && doc[start - 1] !== "\r") start -= 1;

  let end = pos;
  while (end < doc.length && doc[end] !== "\n" && doc[end] !== "\r") end += 1;

  return { start, end };
}

/** Extract qualified identifier parts and per-part quote metadata at position `pos`. */
export function extractIdentifierPartsAt(doc: string, pos: number): ExtractedSqlIdentifierPart[] {
  if (pos < 0 || pos > doc.length) return [];

  const clickPos = pos === doc.length ? pos - 1 : pos;
  if (clickPos < 0) return [];

  const bounds = identifierSearchBounds(doc, clickPos);
  let index = bounds.start;
  while (index < bounds.end) {
    const parsed = parseQualifiedIdentifier(doc, index);
    if (parsed) {
      if (clickPos >= parsed.start && clickPos < parsed.end) {
        return parsed.parts.map((part) => ({ value: part.value, quoted: part.quoted }));
      }
      index = Math.max(parsed.end, index + 1);
      continue;
    }
    index += 1;
  }

  return [];
}

/** Extract identifier and quote metadata at position `pos` in the document. */
export function extractIdentifierDetailsAt(doc: string, pos: number): ExtractedSqlIdentifier | null {
  const parts = extractIdentifierPartsAt(doc, pos);
  if (parts.length === 0) return null;
  return {
    identifier: parts.map((part) => part.value).join("."),
    quoted: parts.some((part) => part.quoted),
  };
}

/** Extract identifier at position `pos` in the document. */
export function extractIdentifierAt(doc: string, pos: number): string | null {
  return extractIdentifierDetailsAt(doc, pos)?.identifier ?? null;
}

/** Check whether the identifier is a SQL keyword (not a table/column name). */
export function isSqlKeyword(identifier: string): boolean {
  return SQL_KEYWORDS_SET.has(identifier.toLowerCase());
}

export function splitQualifiedIdentifier(identifier: string): string[] {
  const trimmed = identifier.trim();
  if (!trimmed) return [];

  const parsed = parseQualifiedIdentifier(trimmed, 0);
  if (!parsed || parsed.end !== trimmed.length) return [trimmed];
  return parsed.parts.map((part) => part.value);
}

/** Match identifier against known table names (case-insensitive). Supports qualified identifiers like schema.table. */
export function matchTable<T extends { name: string; database?: string; schema?: string }>(identifier: string, tables: T[]): T | null {
  const parts = splitQualifiedIdentifier(identifier);
  const normalizedIdentifier = parts.length > 0 ? parts.join(".").toLowerCase() : identifier.toLowerCase();

  const direct = tables.find((t) => t.name.toLowerCase() === normalizedIdentifier);
  if (direct) return direct;

  if (parts.length >= 2) {
    // Use the final two parts so catalog.schema.table still resolves against schema-scoped metadata.
    const qualifier = parts[parts.length - 2].toLowerCase();
    const name = parts[parts.length - 1].toLowerCase();
    const database = parts.length >= 3 ? parts[parts.length - 3].toLowerCase() : undefined;
    const qualified = tables.find((t) => t.name.toLowerCase() === name && t.schema?.toLowerCase() === qualifier && (!database || !t.database || t.database.toLowerCase() === database));
    if (qualified) return qualified;
  }

  return null;
}
