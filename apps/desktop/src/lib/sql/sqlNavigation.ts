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

export type SqlObjectNavigationType = "table" | "view" | "materialized_view" | "procedure" | "function" | "package" | "trigger";

export interface SqlObjectNavigationTarget {
  name: string;
  database?: string;
  schema?: string;
  type?: SqlObjectNavigationType;
  /** Overload signature used by Postgres/SQL Server routines. */
  signature?: string;
  /** Owning package/type name for Oracle package members (or trigger parent table). */
  parentName?: string;
  parentSchema?: string;
}

export function sqlObjectNavigationTarget(table: SqlObjectNavigationTarget): SqlObjectNavigationTarget {
  return {
    name: table.name,
    ...(table.database ? { database: table.database } : {}),
    ...(table.schema ? { schema: table.schema } : {}),
    ...(table.type ? { type: table.type } : {}),
    ...(table.signature ? { signature: table.signature } : {}),
    ...(table.parentName ? { parentName: table.parentName } : {}),
    ...(table.parentSchema ? { parentSchema: table.parentSchema } : {}),
  };
}

export function isSqlObjectNavigationRoutineType(type?: SqlObjectNavigationType): boolean {
  return type === "procedure" || type === "function" || type === "package" || type === "trigger";
}

export function sqlObjectHoverDetail(table: SqlObjectNavigationTarget): string {
  const objectType = table.type === "materialized_view" ? "materialized view" : table.type === "view" ? "view" : table.type === "procedure" ? "procedure" : table.type === "function" ? "function" : table.type === "package" ? "package" : table.type === "trigger" ? "trigger" : "table";
  if (table.parentName) {
    const owner = table.parentSchema ? `${table.parentSchema}.${table.parentName}` : table.parentName;
    return `${objectType} in ${owner}`;
  }
  return table.schema ? `${objectType} in ${table.schema}` : objectType;
}

export function sqlObjectNavigationTableType(table: SqlObjectNavigationTarget): "TABLE" | "VIEW" | "MATERIALIZED_VIEW" {
  if (table.type === "materialized_view") return "MATERIALIZED_VIEW";
  return table.type === "view" ? "VIEW" : "TABLE";
}

/**
 * Maps a navigation target to an object-source kind.
 *
 * Package members (procedure/function with parentName) resolve to PACKAGE_BODY so Oracle
 * ALL_SOURCE can load the owning package body rather than a missing standalone routine.
 */
export function sqlObjectNavigationSourceKind(table: SqlObjectNavigationTarget): ObjectSourceKind | undefined {
  if (table.parentName && (table.type === "procedure" || table.type === "function")) {
    return "PACKAGE_BODY";
  }
  switch (table.type) {
    case "view":
      return "VIEW";
    case "materialized_view":
      return "MATERIALIZED_VIEW";
    case "procedure":
      return "PROCEDURE";
    case "function":
      return "FUNCTION";
    case "package":
      return "PACKAGE";
    case "trigger":
      return "TRIGGER";
    default:
      return undefined;
  }
}

/** Object name to pass to getObjectSource (package body uses the package name). */
export function sqlObjectNavigationSourceName(table: SqlObjectNavigationTarget): string {
  if (table.parentName && (table.type === "procedure" || table.type === "function")) {
    return table.parentName;
  }
  return table.name;
}

/** Schema/owner for getObjectSource. */
export function sqlObjectNavigationSourceSchema(table: SqlObjectNavigationTarget, fallbackSchema?: string): string | undefined {
  if (table.parentName && (table.type === "procedure" || table.type === "function")) {
    return table.parentSchema || table.schema || fallbackSchema;
  }
  return table.schema || fallbackSchema;
}

export function sqlObjectNavigationTypeFromTableType(tableType: string | null | undefined): SqlObjectNavigationType {
  const normalized = tableType
    ?.trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (normalized === "MATERIALIZED_VIEW") return "materialized_view";
  if (normalized === "VIEW") return "view";
  if (normalized === "PROCEDURE") return "procedure";
  if (normalized === "FUNCTION") return "function";
  if (normalized === "PACKAGE" || normalized === "PACKAGE_BODY") return "package";
  if (normalized === "TRIGGER") return "trigger";
  return "table";
}

export function sqlObjectNavigationTypeFromCompletionObjectType(type: string | null | undefined): SqlObjectNavigationType | undefined {
  switch (type) {
    case "procedure":
      return "procedure";
    case "function":
      return "function";
    case "package":
      return "package";
    case "trigger":
      return "trigger";
    default:
      return undefined;
  }
}

export function mergeSqlObjectNavigationType(left?: SqlObjectNavigationType, right?: SqlObjectNavigationType): SqlObjectNavigationType | undefined {
  if (left === "materialized_view" || right === "materialized_view") return "materialized_view";
  if (left === "view" || right === "view") return "view";
  if (isSqlObjectNavigationRoutineType(left)) return left;
  if (isSqlObjectNavigationRoutineType(right)) return right;
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

/**
 * True when the identifier at `pos` is immediately followed by `(` (after optional whitespace),
 * which is the common CALL / PL/SQL invocation shape for procedures and functions.
 */
export function isSqlCallSiteIdentifierAt(doc: string, pos: number): boolean {
  if (pos < 0 || pos > doc.length) return false;
  const clickPos = pos === doc.length ? pos - 1 : pos;
  if (clickPos < 0) return false;

  const bounds = identifierSearchBounds(doc, clickPos);
  let index = bounds.start;
  while (index < bounds.end) {
    const parsed = parseQualifiedIdentifier(doc, index);
    if (parsed) {
      if (clickPos >= parsed.start && clickPos < parsed.end) {
        let cursor = parsed.end;
        while (cursor < doc.length && /\s/.test(doc[cursor] ?? "")) cursor += 1;
        return doc[cursor] === "(";
      }
      index = Math.max(parsed.end, index + 1);
      continue;
    }
    index += 1;
  }
  return false;
}

/**
 * Build a best-effort navigation target from a qualified identifier without waiting for metadata.
 * Used as a fast path for Ctrl/Cmd+click on call sites like `SCHEMA.PROC(...)`.
 */
export function sqlObjectNavigationTargetFromIdentifier(
  identifier: string,
  options?: {
    fallbackSchema?: string;
    /** Prefer procedure for bare call sites; package when the last part is the package itself. */
    preferType?: SqlObjectNavigationType;
  },
): SqlObjectNavigationTarget | null {
  const parts = splitQualifiedIdentifier(identifier);
  if (parts.length === 0) return null;
  const name = parts[parts.length - 1];
  if (!name) return null;

  const preferType = options?.preferType ?? "procedure";

  if (parts.length >= 3) {
    // schema.package.member
    return sqlObjectNavigationTarget({
      name,
      schema: parts[parts.length - 3],
      parentName: parts[parts.length - 2],
      parentSchema: parts[parts.length - 3],
      type: preferType === "function" ? "function" : "procedure",
    });
  }

  if (parts.length === 2) {
    // schema.object OR package.member — prefer schema.standalone procedure for the fast path.
    return sqlObjectNavigationTarget({
      name,
      schema: parts[0],
      type: preferType,
    });
  }

  return sqlObjectNavigationTarget({
    name,
    ...(options?.fallbackSchema ? { schema: options.fallbackSchema } : {}),
    type: preferType,
  });
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

type MatchableSqlObject = {
  name: string;
  schema?: string;
  parentName?: string;
  parentSchema?: string;
};

/**
 * Match identifier against completion routines (procedure / function / package / trigger).
 *
 * Supports:
 * - `proc`
 * - `schema.proc`
 * - `package.proc` (package member)
 * - `schema.package.proc`
 */
export function matchSqlObject<T extends MatchableSqlObject>(identifier: string, objects: readonly T[]): T | null {
  const parts = splitQualifiedIdentifier(identifier);
  if (parts.length === 0) return null;

  const name = parts[parts.length - 1].toLowerCase();
  const same = (left: string | undefined, right: string | undefined) => (left || "").toLowerCase() === (right || "").toLowerCase();

  if (parts.length === 1) {
    // Prefer standalone routines over package members when the identifier is unqualified.
    return objects.find((object) => object.name.toLowerCase() === name && !object.parentName) ?? objects.find((object) => object.name.toLowerCase() === name) ?? null;
  }

  if (parts.length === 2) {
    const qualifier = parts[0].toLowerCase();
    // schema.object (standalone)
    const bySchema = objects.find((object) => object.name.toLowerCase() === name && !object.parentName && object.schema?.toLowerCase() === qualifier) ?? objects.find((object) => object.name.toLowerCase() === name && object.schema?.toLowerCase() === qualifier && !object.parentName);
    if (bySchema) return bySchema;
    // package.member
    const byPackage = objects.find((object) => object.name.toLowerCase() === name && object.parentName?.toLowerCase() === qualifier);
    if (byPackage) return byPackage;
    return null;
  }

  // schema.package.member or catalog.schema.object — use the last three parts.
  const owner = parts[parts.length - 3].toLowerCase();
  const middle = parts[parts.length - 2].toLowerCase();
  const packageMember = objects.find((object) => object.name.toLowerCase() === name && object.parentName?.toLowerCase() === middle && same(object.parentSchema || object.schema, owner));
  if (packageMember) return packageMember;

  // Fallback: schema.object ignoring extra leading catalog parts.
  return objects.find((object) => object.name.toLowerCase() === name && !object.parentName && object.schema?.toLowerCase() === middle) ?? null;
}
