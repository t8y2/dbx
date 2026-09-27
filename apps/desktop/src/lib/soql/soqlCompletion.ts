// Salesforce SOQL completion engine.
//
// SOQL is SQL-like but narrower: a single object per query (FROM), relationship
// traversal via `Relationship.Field` paths, no JOINs, no DDL/DML. This module is a
// PURE function library mirroring lib/mongo/mongoCompletion.ts: a context scanner
// reads the text under the cursor, a builder turns resolved metadata into
// completion items, and an async resolver walks relationship paths using a
// caller-supplied field loader. QueryEditor.vue supplies the store-backed loader
// (which reads the backend describe cache), so nothing here touches I/O directly.

export interface SoqlCompletionObject {
  /** sObject API name, e.g. "Account". */
  name: string;
  /** Human label, e.g. "Account" or a custom object's label. */
  label?: string;
}

export interface SoqlCompletionField {
  /** Field API name, e.g. "StageName". */
  name: string;
  /** Field label, e.g. "Stage". */
  label?: string;
  /** Salesforce describe type: picklist, reference, string, boolean, date, datetime, currency, … */
  type?: string;
  /** Active picklist values (from describe enum_values). */
  picklistValues?: string[];
  /** Relationship name used to traverse a reference field, e.g. "Owner". */
  relationshipName?: string;
  /** Referenced sObject API names, e.g. ["User"]. */
  referenceTo?: string[];
}

export type SoqlCompletionItemType = "column" | "property" | "table" | "function" | "keyword" | "snippet" | "text";

export interface SoqlCompletionItem {
  label: string;
  type: SoqlCompletionItemType;
  detail?: string;
  info?: string;
  apply?: string;
  filterText?: string;
  boost: number;
  /** When completing inside an open string, consume the matching closing quote. */
  replaceClosingQuote?: "'";
}

export type SoqlCompletionMode = "none" | "keyword" | "object" | "field" | "value";

export type SoqlClause = "select" | "from" | "where" | "orderby" | "groupby" | "having" | null;

export interface SoqlValueTarget {
  /** Relationship path segments before the field, e.g. ["Owner"] for `Owner.Name = '…'`. */
  path: string[];
  /** The field being compared, e.g. "StageName". */
  name: string;
}

export interface SoqlCompletionContext {
  mode: SoqlCompletionMode;
  /** Partial identifier immediately before the cursor (last dot segment). */
  prefix: string;
  /** Document position where the completion replacement starts. */
  from: number;
  /** Resolved FROM object API name for the current statement, if any. */
  fromObject?: string;
  /** Relationship path segments before `prefix` (field mode), e.g. ["Owner"] for `Owner.Na|`. */
  relationshipPath?: string[];
  /** Clause the cursor sits in. */
  clause?: SoqlClause;
  /** Value-mode target field (path + name). */
  valueField?: SoqlValueTarget;
  /** Cursor is inside an open single-quoted string (value already being typed). */
  insideString?: boolean;
}

export interface SoqlCompletionInput {
  objects?: SoqlCompletionObject[];
  /** Fields of the object the cursor resolves to (after relationship traversal). */
  fields?: SoqlCompletionField[];
  /** For value mode: the specific field being compared (carries picklistValues/type). */
  valueField?: SoqlCompletionField | null;
}

/** SOQL clause keywords offered at statement start / after a completed clause. */
const SOQL_CLAUSE_KEYWORDS: Array<{ label: string; detail: string; boost: number }> = [
  { label: "SELECT", detail: "Projection clause", boost: 100 },
  { label: "FROM", detail: "Object clause", boost: 98 },
  { label: "WHERE", detail: "Filter clause", boost: 96 },
  { label: "ORDER BY", detail: "Sort clause", boost: 90 },
  { label: "GROUP BY", detail: "Grouping clause", boost: 88 },
  { label: "HAVING", detail: "Aggregate filter", boost: 84 },
  { label: "LIMIT", detail: "Row limit", boost: 80 },
  { label: "OFFSET", detail: "Row offset", boost: 78 },
  { label: "WITH SECURITY_ENFORCED", detail: "Enforce CRUD/FLS", boost: 70 },
  { label: "NULLS FIRST", detail: "Sort nulls first", boost: 60 },
  { label: "NULLS LAST", detail: "Sort nulls last", boost: 60 },
  { label: "ASC", detail: "Ascending", boost: 58 },
  { label: "DESC", detail: "Descending", boost: 58 },
  { label: "AND", detail: "Logical AND", boost: 66 },
  { label: "OR", detail: "Logical OR", boost: 64 },
  { label: "NOT", detail: "Logical NOT", boost: 62 },
  { label: "IN", detail: "Set membership", boost: 60 },
  { label: "LIKE", detail: "Pattern match", boost: 60 },
  { label: "INCLUDES", detail: "Multi-picklist includes", boost: 58 },
  { label: "EXCLUDES", detail: "Multi-picklist excludes", boost: 58 },
];

/** Aggregate / conversion functions valid in SELECT, GROUP BY, HAVING. */
const SOQL_FUNCTIONS: Array<{ label: string; detail: string; apply?: string }> = [
  { label: "COUNT", detail: "Row count", apply: "COUNT()" },
  { label: "COUNT_DISTINCT", detail: "Distinct count", apply: "COUNT_DISTINCT()" },
  { label: "SUM", detail: "Sum", apply: "SUM()" },
  { label: "AVG", detail: "Average", apply: "AVG()" },
  { label: "MIN", detail: "Minimum", apply: "MIN()" },
  { label: "MAX", detail: "Maximum", apply: "MAX()" },
  { label: "GROUPING", detail: "Grouping indicator", apply: "GROUPING()" },
  { label: "convertCurrency", detail: "Convert to user currency", apply: "convertCurrency()" },
  { label: "convertTimezone", detail: "Convert datetime to user TZ", apply: "convertTimezone()" },
  { label: "toLabel", detail: "Return picklist/reference label", apply: "toLabel()" },
  { label: "CALENDAR_YEAR", detail: "Year from date", apply: "CALENDAR_YEAR()" },
  { label: "CALENDAR_MONTH", detail: "Month from date", apply: "CALENDAR_MONTH()" },
  { label: "CALENDAR_QUARTER", detail: "Quarter from date", apply: "CALENDAR_QUARTER()" },
  { label: "DAY_ONLY", detail: "Date portion of datetime", apply: "DAY_ONLY()" },
  { label: "FISCAL_YEAR", detail: "Fiscal year from date", apply: "FISCAL_YEAR()" },
  { label: "FISCAL_QUARTER", detail: "Fiscal quarter from date", apply: "FISCAL_QUARTER()" },
];

/** FIELDS() selectors — SOQL's "expand all fields" (LIMIT ≤ 200; the driver auto-appends LIMIT 200 when missing). */
const SOQL_FIELDS_SELECTORS: Array<{ label: string; detail: string }> = [
  { label: "FIELDS(ALL)", detail: "All fields (LIMIT 200 auto-added if missing)" },
  { label: "FIELDS(STANDARD)", detail: "All standard fields" },
  { label: "FIELDS(CUSTOM)", detail: "All custom fields (LIMIT 200 auto-added if missing)" },
];

/** SOQL date literals offered in value position for date/datetime fields. */
const SOQL_DATE_LITERALS: string[] = [
  "YESTERDAY",
  "TODAY",
  "TOMORROW",
  "LAST_WEEK",
  "THIS_WEEK",
  "NEXT_WEEK",
  "LAST_MONTH",
  "THIS_MONTH",
  "NEXT_MONTH",
  "LAST_90_DAYS",
  "NEXT_90_DAYS",
  "LAST_N_DAYS:n",
  "NEXT_N_DAYS:n",
  "LAST_QUARTER",
  "THIS_QUARTER",
  "NEXT_QUARTER",
  "LAST_N_QUARTERS:n",
  "NEXT_N_QUARTERS:n",
  "LAST_YEAR",
  "THIS_YEAR",
  "NEXT_YEAR",
  "LAST_N_YEARS:n",
  "NEXT_N_YEARS:n",
  "LAST_FISCAL_QUARTER",
  "THIS_FISCAL_QUARTER",
  "NEXT_FISCAL_QUARTER",
  "LAST_FISCAL_YEAR",
  "THIS_FISCAL_YEAR",
  "NEXT_FISCAL_YEAR",
];

const SOQL_AGGREGATE_CLAUSES = new Set<SoqlClause>(["select", "groupby", "having"]);

const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * Scan the text under the cursor and classify the SOQL completion context.
 * Pure and synchronous — metadata resolution happens in the provider.
 *
 * All backward scanning is scoped to the CURRENT statement (text after the last
 * `;`): a completed statement's `WHERE x > 1` must not make the next statement's
 * `SELECT F|` look like a value context, and its FROM/clauses must not leak in.
 * Returned `from` positions are always absolute document offsets.
 */
export function getSoqlCompletionContext(text: string, cursor: number): SoqlCompletionContext {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const beforeCursor = text.slice(0, safeCursor);
  const statementStart = beforeCursor.lastIndexOf(";") + 1;
  const statement = beforeCursor.slice(statementStart);

  const fromObject = findFromObject(text, safeCursor);
  const clause = findClause(statement);

  // Value context: cursor sits inside an open single-quoted string, or right after
  // a comparison operator (optionally a just-opened quote). `stringStart` is
  // statement-relative; convert to an absolute offset before returning.
  const stringStart = openSingleQuoteStart(statement);
  const valueTarget = parseValueTarget(statement, stringStart);
  if (valueTarget) {
    const insideString = stringStart != null;
    const trailing = readTrailingPrefix(statement);
    return {
      mode: "value",
      prefix: insideString ? statement.slice(stringStart + 1) : trailing.prefix,
      from: insideString ? statementStart + stringStart + 1 : safeCursor - trailing.prefix.length,
      fromObject,
      clause,
      valueField: { path: valueTarget.path, name: valueTarget.name },
      insideString,
    };
  }

  // Object context: the cursor is in the FROM clause completing an sObject name.
  if (clause === "from") {
    const { prefix, from } = readTrailingPrefix(statement);
    return { mode: "object", prefix, from: statementStart + from, fromObject, clause };
  }

  // Field context: SELECT / WHERE / ORDER BY / GROUP BY / HAVING (clause === "from"
  // already returned above, so any remaining clause is a field clause).
  if (clause) {
    const { prefix, from, path } = readTrailingPrefix(statement);
    return { mode: "field", prefix, from: statementStart + from, fromObject, relationshipPath: path, clause };
  }

  // No clause yet (empty/fresh statement, or only whitespace typed): offer clauses.
  const { prefix, from } = readTrailingPrefix(statement);
  if (prefix || statement.trim().length === 0) {
    return { mode: "keyword", prefix, from: statementStart + from, fromObject, clause: null };
  }
  return { mode: "none", prefix: "", from: safeCursor, fromObject, clause };
}

/**
 * Find the FROM object of the statement containing the cursor. Scoped to the
 * current statement (`;`-separated) so a neighbouring query's FROM never leaks
 * field candidates into this one; within the statement prefer the nearest FROM
 * before the cursor, else the first one after it (the user is often still
 * typing the projection when FROM exists only ahead of the cursor).
 */
function findFromObject(text: string, cursor: number): string | undefined {
  const statementStart = text.lastIndexOf(";", cursor - 1) + 1;
  const semicolonAfter = text.indexOf(";", cursor);
  const statementEnd = semicolonAfter === -1 ? text.length : semicolonAfter;
  const statement = text.slice(statementStart, statementEnd);
  const re = /\bfrom\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  let lastBefore: string | undefined;
  let firstAfter: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = re.exec(statement)) !== null) {
    const name = match[1];
    if (statementStart + match.index < cursor) lastBefore = name;
    else if (firstAfter == null) firstAfter = name;
  }
  return lastBefore ?? firstAfter;
}

/** Identify the clause the cursor is in from the last clause keyword before it. */
function findClause(beforeCursor: string): SoqlClause {
  const upper = beforeCursor.toUpperCase();
  const markers: Array<{ kw: RegExp; clause: SoqlClause }> = [
    { kw: /\bORDER\s+BY\b/g, clause: "orderby" },
    { kw: /\bGROUP\s+BY\b/g, clause: "groupby" },
    { kw: /\bHAVING\b/g, clause: "having" },
    { kw: /\bWHERE\b/g, clause: "where" },
    { kw: /\bFROM\b/g, clause: "from" },
    { kw: /\bSELECT\b/g, clause: "select" },
  ];
  let best: { index: number; clause: SoqlClause } | null = null;
  for (const { kw, clause } of markers) {
    kw.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = kw.exec(upper)) !== null) {
      if (!best || m.index > best.index) best = { index: m.index, clause };
      if (m.index === kw.lastIndex) kw.lastIndex++;
    }
  }
  return best ? best.clause : null;
}

/**
 * If the cursor is inside an unterminated single-quoted string, return the index of
 * the opening quote; otherwise null. Handles backslash escapes.
 */
function openSingleQuoteStart(beforeCursor: string): number | null {
  let open: number | null = null;
  for (let i = 0; i < beforeCursor.length; i++) {
    const ch = beforeCursor[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'") {
      if (open == null) open = i;
      else open = null;
    }
  }
  return open;
}

/**
 * Parse `<fieldPath> <op> ['…]` immediately before the cursor. Returns the field path
 * and name when the cursor is in a value position, else null.
 */
function parseValueTarget(beforeCursor: string, stringStart: number | null): { path: string[]; name: string } | null {
  // Text up to (and excluding) the operator, dropping any partial string content.
  const head = stringStart != null ? beforeCursor.slice(0, stringStart) : beforeCursor;
  const m = /([A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*(?:=|!=|<>|<=|>=|<|>|\bLIKE\b|\bIN\b|\bINCLUDES\b|\bEXCLUDES\b)\s*'?[^']*$/i.exec(head);
  if (!m) return null;
  // When not inside a string, only treat as a value context if the operator is complete
  // and followed by optional whitespace/quote (avoid matching `Name` in SELECT).
  const segments = m[1].split(/\s*\.\s*/).filter(Boolean);
  if (segments.length === 0) return null;
  const name = segments[segments.length - 1];
  return { path: segments.slice(0, -1), name };
}

/**
 * Read the trailing dotted identifier under the cursor. Returns the last segment as
 * `prefix`, the replacement start `from`, and preceding segments as `path`.
 */
function readTrailingPrefix(beforeCursor: string): { prefix: string; from: number; path: string[] } {
  let i = beforeCursor.length;
  while (i > 0 && (WORD_CHAR.test(beforeCursor[i - 1]) || beforeCursor[i - 1] === ".")) i--;
  const span = beforeCursor.slice(i);
  if (!span) return { prefix: "", from: beforeCursor.length, path: [] };
  const segments = span.split(".");
  const prefix = segments[segments.length - 1] ?? "";
  const path = segments.slice(0, -1).filter((seg) => seg.length > 0);
  const from = beforeCursor.length - prefix.length;
  return { prefix, from, path };
}

/**
 * Walk a relationship path from the FROM object, returning the fields of the final
 * object. `loadFields` reads the (cached) describe metadata for one sObject.
 */
export async function resolveSoqlFieldCandidates(context: SoqlCompletionContext, loadFields: (objectName: string) => Promise<SoqlCompletionField[]>): Promise<SoqlCompletionField[]> {
  if (!context.fromObject) return [];
  let fields = await loadFields(context.fromObject);
  for (const segment of context.relationshipPath ?? []) {
    const rel = fields.find((f) => (f.relationshipName ?? "").toLowerCase() === segment.toLowerCase() || f.name.toLowerCase() === segment.toLowerCase());
    const next = rel?.referenceTo?.[0];
    if (!next) return [];
    fields = await loadFields(next);
  }
  return fields;
}

/**
 * Resolve the specific field a value-mode cursor compares against (walking its
 * relationship path), so the builder can offer its picklist values / type-aware literals.
 */
export async function resolveSoqlValueField(context: SoqlCompletionContext, loadFields: (objectName: string) => Promise<SoqlCompletionField[]>): Promise<SoqlCompletionField | null> {
  if (!context.fromObject || !context.valueField) return null;
  let fields = await loadFields(context.fromObject);
  for (const segment of context.valueField.path) {
    const rel = fields.find((f) => (f.relationshipName ?? "").toLowerCase() === segment.toLowerCase() || f.name.toLowerCase() === segment.toLowerCase());
    const next = rel?.referenceTo?.[0];
    if (!next) return null;
    fields = await loadFields(next);
  }
  return fields.find((f) => f.name.toLowerCase() === context.valueField!.name.toLowerCase()) ?? null;
}

/** True when the given mode's items come from the object list. */
export function soqlCompletionNeedsObjects(mode: SoqlCompletionMode): boolean {
  return mode === "object";
}

/** True when the given mode's items come from field metadata. */
export function soqlCompletionNeedsFields(mode: SoqlCompletionMode): boolean {
  return mode === "field" || mode === "value";
}

/**
 * Build completion items for a resolved context. `input.fields` must already be the
 * fields of the object the cursor resolves to (see resolveSoqlFieldCandidates);
 * `input.valueField` is the compared field for value mode.
 */
export function buildSoqlCompletionItems(context: SoqlCompletionContext, input: SoqlCompletionInput = {}): SoqlCompletionItem[] {
  const { prefix } = context;
  switch (context.mode) {
    case "none":
      return [];
    case "keyword":
      return keywordItems(prefix);
    case "object":
      return objectItems(prefix, input.objects ?? []);
    case "value":
      return valueItems(prefix, input.valueField ?? null, context.insideString === true);
    case "field":
      return fieldItems(prefix, context, input.fields ?? []);
    default:
      return [];
  }
}

function keywordItems(prefix: string): SoqlCompletionItem[] {
  const lower = prefix.toLowerCase();
  return SOQL_CLAUSE_KEYWORDS.filter((k) => matchesPrefix(k.label, lower)).map((k) => ({
    label: k.label,
    type: "keyword" as const,
    detail: k.detail,
    boost: k.boost,
    filterText: k.label.replace(/\s+/g, ""),
  }));
}

function objectItems(prefix: string, objects: SoqlCompletionObject[]): SoqlCompletionItem[] {
  const lower = prefix.toLowerCase();
  return objects
    .filter((o) => matchesPrefix(o.name, lower) || matchesPrefix(o.label ?? "", lower))
    .map((o) => ({
      label: o.name,
      type: "table" as const,
      detail: o.label && o.label !== o.name ? o.label : "sObject",
      filterText: o.name,
      // Rank standard objects (no __c/__kav suffix) slightly above custom for a tidy list.
      boost: o.name.endsWith("__c") ? 90 : 100,
    }));
}

function fieldItems(prefix: string, context: SoqlCompletionContext, fields: SoqlCompletionField[]): SoqlCompletionItem[] {
  const lower = prefix.toLowerCase();
  const items: SoqlCompletionItem[] = [];

  for (const field of fields) {
    if (!matchesPrefix(field.name, lower) && !matchesPrefix(field.label ?? "", lower)) continue;
    const isRelationship = !!field.relationshipName && (field.referenceTo?.length ?? 0) > 0;
    items.push({
      label: field.name,
      type: isRelationship ? "property" : "column",
      detail: describeField(field),
      info: field.label && field.label !== field.name ? field.label : undefined,
      filterText: field.name,
      // Offer `Relationship.` traversal by appending a dot when accepted.
      apply: isRelationship ? `${field.relationshipName}.` : field.name,
      boost: 100,
    });
  }

  // Relationship-name traversal is already covered above (reference fields apply as
  // `Relationship.`). In aggregate-capable clauses, also offer functions and selectors.
  if (SOQL_AGGREGATE_CLAUSES.has(context.clause ?? null)) {
    for (const fn of SOQL_FUNCTIONS) {
      if (!matchesPrefix(fn.label, lower)) continue;
      items.push({ label: fn.label, type: "function", detail: fn.detail, apply: fn.apply, filterText: fn.label, boost: 78 });
    }
  }
  if ((context.clause ?? null) === "select" && !context.relationshipPath?.length) {
    for (const sel of SOQL_FIELDS_SELECTORS) {
      if (!matchesPrefix(sel.label, lower) && !matchesPrefix("fields", lower)) continue;
      items.push({ label: sel.label, type: "snippet", detail: sel.detail, apply: sel.label, filterText: sel.label.replace(/\W/g, ""), boost: 72 });
    }
  }
  return items;
}

function valueItems(prefix: string, field: SoqlCompletionField | null, insideString: boolean): SoqlCompletionItem[] {
  const lower = prefix.toLowerCase();
  const items: SoqlCompletionItem[] = [];
  const type = (field?.type ?? "").toLowerCase();

  // `quoted` literals (picklist/string values) need surrounding single quotes. When the
  // cursor is already inside an open string we insert the bare value and consume the
  // closing quote; otherwise we insert a fully quoted literal. Unquoted literals
  // (NULL / TRUE / FALSE / date literals) are inserted bare either way.
  const addValues = (values: string[], detail: string, boost: number, quoted: boolean) => {
    for (const value of values) {
      if (!matchesPrefix(value, lower)) continue;
      if (quoted && !insideString) {
        items.push({ label: value, type: "text", detail, boost, apply: `'${value}'`, filterText: value });
      } else {
        items.push({
          label: value,
          type: "text",
          detail,
          boost,
          apply: value,
          filterText: value,
          ...(quoted && insideString ? { replaceClosingQuote: "'" as const } : {}),
        });
      }
    }
  };

  if (field?.picklistValues?.length) {
    addValues(field.picklistValues, "Picklist value", 100, true);
  }
  if (type === "boolean") {
    addValues(["TRUE", "FALSE"], "Boolean", 96, false);
  }
  if (type === "date" || type === "datetime") {
    addValues(SOQL_DATE_LITERALS, "Date literal", 92, false);
  }
  // Universally valid literals.
  addValues(["NULL"], "Null literal", 70, false);
  if (!field || type === "string" || type === "textarea" || type === "email" || type === "phone" || type === "url") {
    addValues(["TRUE", "FALSE"], "Boolean", 40, false);
  }
  return items;
}

function describeField(field: SoqlCompletionField): string {
  const parts: string[] = [];
  if (field.type) parts.push(field.type);
  if (field.relationshipName && field.referenceTo?.length) parts.push(`→ ${field.referenceTo.join(", ")}`);
  return parts.join(" ");
}

function matchesPrefix(candidate: string, lowerPrefix: string): boolean {
  if (!lowerPrefix) return true;
  return candidate.toLowerCase().startsWith(lowerPrefix);
}

/**
 * Whether typing at this cursor should auto-open the completion popup. Mirrors the
 * mongo/redis providers: open on relationship dots, after clause keywords + space,
 * inside a just-opened quote, and while typing an identifier.
 */
export function shouldAutoOpenSoqlCompletion(text: string, cursor: number): boolean {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, safeCursor);
  const prevChar = before[before.length - 1];
  if (!prevChar) return false;
  if (prevChar === ".") return true;
  if (prevChar === "'") return true;
  if (/\s$/.test(before)) {
    const ctx = getSoqlCompletionContext(text, safeCursor);
    return ctx.mode !== "none";
  }
  if (WORD_CHAR.test(prevChar)) return true;
  return false;
}

/**
 * validFor predicate source: completions stay valid while the user keeps typing the
 * identifier/value characters. Returned as a RegExp like the mongo/redis providers.
 */
export function getSoqlCompletionResultValidFor(context: SoqlCompletionContext): RegExp {
  // In value mode inside a string, valid while the typed slice has no closing quote.
  if (context.mode === "value" && context.insideString) return /^[^']*$/;
  return /^[A-Za-z0-9_.]*$/;
}
