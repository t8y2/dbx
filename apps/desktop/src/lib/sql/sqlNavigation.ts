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

/**
 * Semantic role of a Ctrl/Cmd+clicked identifier for navigation.
 *
 * - `relation_column_list`: name is a table/view followed by `(cols)` (INSERT INTO t(...), CREATE TABLE t(...), …)
 * - `routine_call`: name is invoked as a call / PL/SQL unit (`proc(...)`, `pkg.member(...)`)
 * - `unknown`: plain identifier; resolve via metadata (table first, then routine)
 */
export type SqlObjectNavigationRole = "relation_column_list" | "routine_call" | "unknown";

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
  /** Quote metadata so Oracle keeps mixed-case identities (`"MiXeDProc"`). */
  nameQuoted?: boolean;
  schemaQuoted?: boolean;
  parentNameQuoted?: boolean;
  parentSchemaQuoted?: boolean;
}

/**
 * Fully resolved click identity: parts, quotes, and navigation role.
 * Built before any remote metadata call so call-site vs table and package vs schema
 * decisions share one model instead of scattered if/else branches.
 */
export interface SqlObjectNavigationIdentity {
  identifier: string;
  parts: ExtractedSqlIdentifierPart[];
  start: number;
  end: number;
  name: string;
  nameQuoted: boolean;
  /** Leading qualifier for 2-part names (schema OR package — still ambiguous until metadata). */
  qualifier?: string;
  qualifierQuoted?: boolean;
  /** Owner/schema when 3-part (schema.package.member) or when metadata resolves schema.routine. */
  schema?: string;
  schemaQuoted?: boolean;
  role: SqlObjectNavigationRole;
  /**
   * Two-part `A.B(...)` is ambiguous between `schema.routine` and `package.member`.
   * Optimistic open prefers package.member under the session schema (Oracle common case)
   * only after metadata lookups fail.
   */
  twoPartAmbiguous: boolean;
  followedByParen: boolean;
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
    ...(table.nameQuoted ? { nameQuoted: true } : {}),
    ...(table.schemaQuoted ? { schemaQuoted: true } : {}),
    ...(table.parentNameQuoted ? { parentNameQuoted: true } : {}),
    ...(table.parentSchemaQuoted ? { parentSchemaQuoted: true } : {}),
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

/** Locate the qualified identifier covering `pos`, including quote flags and document range. */
export function extractQualifiedIdentifierAt(doc: string, pos: number): { parts: ExtractedSqlIdentifierPart[]; start: number; end: number } | null {
  if (pos < 0 || pos > doc.length) return null;

  const clickPos = pos === doc.length ? pos - 1 : pos;
  if (clickPos < 0) return null;

  const bounds = identifierSearchBounds(doc, clickPos);
  let index = bounds.start;
  while (index < bounds.end) {
    const parsed = parseQualifiedIdentifier(doc, index);
    if (parsed) {
      if (clickPos >= parsed.start && clickPos < parsed.end) {
        return {
          parts: parsed.parts.map((part) => ({ value: part.value, quoted: part.quoted })),
          start: parsed.start,
          end: parsed.end,
        };
      }
      index = Math.max(parsed.end, index + 1);
      continue;
    }
    index += 1;
  }

  return null;
}

/** Extract qualified identifier parts and per-part quote metadata at position `pos`. */
export function extractIdentifierPartsAt(doc: string, pos: number): ExtractedSqlIdentifierPart[] {
  return extractQualifiedIdentifierAt(doc, pos)?.parts ?? [];
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
 * True when the identifier at `pos` is immediately followed by `(` (after optional whitespace).
 * Not sufficient alone for routine navigation — also see {@link isSqlRelationColumnListContext}.
 */
export function isSqlCallSiteIdentifierAt(doc: string, pos: number): boolean {
  const located = extractQualifiedIdentifierAt(doc, pos);
  if (!located) return false;
  let cursor = located.end;
  while (cursor < doc.length && /\s/.test(doc[cursor] ?? "")) cursor += 1;
  return doc[cursor] === "(";
}

/**
 * True when `before` (text immediately before a qualified identifier) is a relation definition
 * / DML target where a following `(` starts a column list, not a routine call.
 *
 * Examples: `INSERT INTO t(`, `CREATE TABLE t(`, `CREATE OR REPLACE VIEW v(`, `CREATE INDEX i ON t(`.
 */
export function isSqlRelationColumnListContext(beforeIdentifier: string): boolean {
  const cleaned = beforeIdentifier
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ")
    .trimEnd();
  // Trailing space optional; match statement keywords that introduce a relation then `(`.
  return /(?:^|[\s(])(?:insert\s+into|merge\s+into|update|create\s+(?:global\s+temporary\s+)?table|create\s+(?:or\s+replace\s+)?(?:(?:no)?force\s+)?(?:(?:non)?editionable\s+)?view|create\s+(?:unique\s+|bitmap\s+)?index(?:\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*))?\s+on|alter\s+table)$/i.test(
    cleaned,
  );
}

/**
 * True when the identifier is a routine-call navigation candidate (not a relation column list).
 * `INSERT INTO ORDERS(ID)` → false; `BEGIN PROC_NAME()` → true.
 */
export function isSqlRoutineCallNavigationCandidate(doc: string, pos: number): boolean {
  const located = extractQualifiedIdentifierAt(doc, pos);
  if (!located) return false;
  let cursor = located.end;
  while (cursor < doc.length && /\s/.test(doc[cursor] ?? "")) cursor += 1;
  if (doc[cursor] !== "(") return false;
  return !isSqlRelationColumnListContext(doc.slice(0, located.start));
}

/**
 * Resolve the full navigation identity at a click position (role + quote-aware parts).
 */
export function resolveSqlObjectNavigationIdentity(doc: string, pos: number): SqlObjectNavigationIdentity | null {
  const located = extractQualifiedIdentifierAt(doc, pos);
  if (!located || located.parts.length === 0) return null;

  const parts = located.parts;
  const namePart = parts[parts.length - 1];
  if (!namePart) return null;
  if (!namePart.quoted && isSqlKeyword(namePart.value)) return null;

  let cursor = located.end;
  while (cursor < doc.length && /\s/.test(doc[cursor] ?? "")) cursor += 1;
  const followedByParen = doc[cursor] === "(";
  const relationColumnList = followedByParen && isSqlRelationColumnListContext(doc.slice(0, located.start));

  let role: SqlObjectNavigationRole = "unknown";
  if (relationColumnList) role = "relation_column_list";
  else if (followedByParen) role = "routine_call";

  const identity: SqlObjectNavigationIdentity = {
    identifier: parts.map((part) => part.value).join("."),
    parts,
    start: located.start,
    end: located.end,
    name: namePart.value,
    nameQuoted: namePart.quoted,
    role,
    twoPartAmbiguous: parts.length === 2 && role === "routine_call",
    followedByParen,
  };

  if (parts.length >= 3) {
    const schemaPart = parts[parts.length - 3];
    const packagePart = parts[parts.length - 2];
    if (schemaPart) {
      identity.schema = schemaPart.value;
      identity.schemaQuoted = schemaPart.quoted;
    }
    if (packagePart) {
      identity.qualifier = packagePart.value;
      identity.qualifierQuoted = packagePart.quoted;
    }
  } else if (parts.length === 2) {
    const qualifierPart = parts[0];
    if (qualifierPart) {
      identity.qualifier = qualifierPart.value;
      identity.qualifierQuoted = qualifierPart.quoted;
    }
  }

  return identity;
}

/**
 * Build a navigation target from a resolved identity for optimistic routine open.
 *
 * - 1-part: session/fallback schema + procedure name
 * - 2-part ambiguous: prefer package.member under fallback schema (not schema.routine)
 * - 3-part: schema.package.member
 */
export function sqlObjectNavigationTargetFromIdentity(
  identity: SqlObjectNavigationIdentity,
  options?: {
    fallbackSchema?: string;
    preferType?: SqlObjectNavigationType;
    /** Force schema.routine interpretation for 2-part names (metadata-confirmed). */
    asSchemaRoutine?: boolean;
    /** Force package.member interpretation (default for ambiguous 2-part optimistic). */
    asPackageMember?: boolean;
    signature?: string;
  },
): SqlObjectNavigationTarget | null {
  if (!identity.name) return null;
  const preferType = options?.preferType ?? "procedure";
  const type: SqlObjectNavigationType = preferType === "function" ? "function" : preferType === "package" ? "package" : "procedure";

  if (identity.parts.length >= 3) {
    return sqlObjectNavigationTarget({
      name: identity.name,
      nameQuoted: identity.nameQuoted,
      schema: identity.schema,
      schemaQuoted: identity.schemaQuoted,
      parentName: identity.qualifier,
      parentNameQuoted: identity.qualifierQuoted,
      parentSchema: identity.schema,
      parentSchemaQuoted: identity.schemaQuoted,
      type,
      ...(options?.signature ? { signature: options.signature } : {}),
    });
  }

  if (identity.parts.length === 2 && identity.qualifier) {
    const asPackageMember = options?.asPackageMember ?? (!options?.asSchemaRoutine && identity.twoPartAmbiguous);
    if (asPackageMember) {
      return sqlObjectNavigationTarget({
        name: identity.name,
        nameQuoted: identity.nameQuoted,
        schema: options?.fallbackSchema,
        parentName: identity.qualifier,
        parentNameQuoted: identity.qualifierQuoted,
        parentSchema: options?.fallbackSchema,
        type,
        ...(options?.signature ? { signature: options.signature } : {}),
      });
    }
    return sqlObjectNavigationTarget({
      name: identity.name,
      nameQuoted: identity.nameQuoted,
      schema: identity.qualifier,
      schemaQuoted: identity.qualifierQuoted,
      type,
      ...(options?.signature ? { signature: options.signature } : {}),
    });
  }

  return sqlObjectNavigationTarget({
    name: identity.name,
    nameQuoted: identity.nameQuoted,
    ...(options?.fallbackSchema ? { schema: options.fallbackSchema } : {}),
    type,
    ...(options?.signature ? { signature: options.signature } : {}),
  });
}

/**
 * @deprecated Prefer {@link sqlObjectNavigationTargetFromIdentity} so quote flags and package/schema
 * ambiguity stay consistent with the click identity model.
 */
export function sqlObjectNavigationTargetFromIdentifier(
  identifier: string,
  options?: {
    fallbackSchema?: string;
    preferType?: SqlObjectNavigationType;
  },
): SqlObjectNavigationTarget | null {
  // Synthesize an identity for string-only callers (tests / legacy).
  const syntheticDoc = identifier;
  const identity = resolveSqlObjectNavigationIdentity(syntheticDoc, Math.max(0, syntheticDoc.length - 1));
  if (!identity) return null;
  // String-only path has no surrounding SQL; treat as routine when multi-part.
  if (identity.parts.length >= 2) {
    identity.role = "routine_call";
    identity.twoPartAmbiguous = identity.parts.length === 2;
    identity.followedByParen = true;
  }
  return sqlObjectNavigationTargetFromIdentity(identity, options);
}

/**
 * Oracle stores unquoted identifiers as uppercase. Quoted identities keep their written case.
 * Apply before getObjectSource so mixed-case `"MiXeDProc"` is not forced to `MIXEDPROC`.
 */
export function normalizeOracleNavigationIdentityName(name: string, quoted?: boolean): string {
  return quoted ? name : name.toUpperCase();
}

/** Normalize schema/name/parent fields on a navigation target for Oracle metadata APIs. */
export function normalizeOracleNavigationTarget(target: SqlObjectNavigationTarget): SqlObjectNavigationTarget {
  return sqlObjectNavigationTarget({
    ...target,
    name: normalizeOracleNavigationIdentityName(target.name, target.nameQuoted),
    ...(target.schema != null ? { schema: normalizeOracleNavigationIdentityName(target.schema, target.schemaQuoted) } : {}),
    ...(target.parentName != null ? { parentName: normalizeOracleNavigationIdentityName(target.parentName, target.parentNameQuoted) } : {}),
    ...(target.parentSchema != null ? { parentSchema: normalizeOracleNavigationIdentityName(target.parentSchema, target.parentSchemaQuoted) } : {}),
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
