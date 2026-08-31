import type { DatabaseType } from "@/types/database";

export type SqlParameterValueKind = "string" | "number" | "boolean" | "null" | "raw";

export interface SqlParameterInput {
  kind: SqlParameterValueKind;
  value: string;
}

export type SqlParameterSyntax = "positional" | "named" | "shell" | "mybatis" | "sqlserver";

export interface SqlParameterDescriptor {
  key: string;
  name: string;
  syntax: SqlParameterSyntax;
  token: string;
  collection?: boolean;
}

export interface SqlBracedParameter extends SqlParameterDescriptor {
  start: number;
  end: number;
}

interface ParameterOccurrence extends SqlParameterDescriptor {
  start: number;
  end: number;
  replacement?: "string-fragment" | "quoted-string" | "mybatis-foreach" | "mybatis-where";
  foreach?: MyBatisForeach;
  where?: MyBatisWhere;
}

interface MyBatisWhere {
  body: string;
}

interface MyBatisForeach {
  item: string;
  index?: string;
  open: string;
  separator: string;
  close: string;
  body: string;
}

interface DuckDbStructLiteralContext {
  bracketDepth: number;
  parenthesisDepth: number;
  separators: Set<number>;
  valid: boolean;
}

type ComplexTypeDeclarationKind = "struct" | "variant";
type TriggerPseudoRecordName = "new" | "old" | "parent" | "eventinfo";

export interface SqlParameterOptions {
  databaseType?: DatabaseType;
  // Which placeholder syntaxes are recognized. Undefined enables all of them.
  enabledSyntaxes?: readonly SqlParameterSyntax[];
}

const PARAMETER_NAME_RE = /^[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*$/u;
const PARAMETER_NAME_START_RE = /[\p{L}_]/u;
const PARAMETER_NAME_CHAR_RE = /[\p{L}\p{N}_]/u;
const SQL_SERVER_TEMP_TABLE_CONTEXT_KEYWORDS = new Set(["table", "from", "join", "into", "update", "truncate"]);
const MYSQL_ROUTINE_LABEL_STATEMENTS = new Set(["begin", "loop", "while", "repeat"]);
const MYSQL_ROUTINE_LABEL_CONTEXTS = new Set(["begin", "then", "else", "do", "loop", "repeat"]);
const MYSQL_ROUTINE_LABEL_RE = /(?:`(?:``|[^`])+`|[\p{L}_][\p{L}\p{N}_]*)$/u;
const POSTGRES_QUESTION_PARAMETER_PREFIX_KEYWORDS = new Set([
  "all",
  "and",
  "any",
  "as",
  "between",
  "by",
  "case",
  "collate",
  "distinct",
  "else",
  "fetch",
  "filter",
  "first",
  "for",
  "from",
  "group",
  "groups",
  "having",
  "ilike",
  "in",
  "interval",
  "into",
  "is",
  "like",
  "limit",
  "next",
  "not",
  "offset",
  "on",
  "or",
  "order",
  "over",
  "partition",
  "placing",
  "range",
  "returning",
  "rows",
  "select",
  "set",
  "similar",
  "some",
  "then",
  "to",
  "using",
  "values",
  "when",
  "where",
  "window",
  "zone",
]);
const POSTGRES_QUESTION_OPERATOR_TRAILING_KEYWORDS = new Set([
  "and",
  "as",
  "between",
  "else",
  "end",
  "except",
  "fetch",
  "filter",
  "from",
  "group",
  "having",
  "ilike",
  "in",
  "intersect",
  "is",
  "join",
  "like",
  "limit",
  "offset",
  "on",
  "or",
  "order",
  "over",
  "returning",
  "then",
  "union",
  "when",
  "where",
  "window",
]);

export function readSqlBracedParameterAt(sql: string, start: number, options?: SqlParameterOptions): SqlBracedParameter | null {
  const open = sql.slice(start, start + 2);
  const syntax: SqlParameterSyntax | null = open === "${" ? "shell" : open === "#{" ? "mybatis" : null;
  if (!syntax || (options?.enabledSyntaxes && !options.enabledSyntaxes.includes(syntax))) return null;

  const closeBrace = sql.indexOf("}", start + 2);
  if (closeBrace === -1) return null;
  const name = sql.slice(start + 2, closeBrace).trim();
  if (!PARAMETER_NAME_RE.test(name)) return null;

  return { key: name, name, syntax, token: sql.slice(start, closeBrace + 1), start, end: closeBrace + 1 };
}

export function extractSqlParameters(sql: string, options?: SqlParameterOptions): string[] {
  return extractSqlParameterDescriptors(sql, options).map((descriptor) => descriptor.key);
}

export function extractSqlParameterDescriptors(sql: string, options?: SqlParameterOptions): SqlParameterDescriptor[] {
  const names = new Set<string>();
  const descriptors: SqlParameterDescriptor[] = [];
  const appendDescriptor = (descriptor: SqlParameterDescriptor) => {
    if (names.has(descriptor.key)) {
      if (descriptor.collection) {
        const existing = descriptors.find((item) => item.key === descriptor.key);
        if (existing) Object.assign(existing, { token: descriptor.token, collection: true });
      }
      return;
    }
    names.add(descriptor.key);
    descriptors.push(descriptor);
  };
  for (const occurrence of findSqlParameterOccurrences(sql, options)) {
    if (occurrence.replacement === "mybatis-where" && occurrence.where) {
      for (const nested of extractSqlParameterDescriptors(occurrence.where.body, options)) appendDescriptor(nested);
      continue;
    }
    appendDescriptor({
      key: occurrence.key,
      name: occurrence.name,
      syntax: occurrence.syntax,
      token: occurrence.token,
      ...(occurrence.collection ? { collection: true } : {}),
    });
    if (occurrence.replacement === "mybatis-foreach" && occurrence.foreach) {
      for (const nested of extractSqlParameterDescriptors(occurrence.foreach.body, options)) {
        if (nested.key !== occurrence.foreach.item && nested.key !== occurrence.foreach.index) appendDescriptor(nested);
      }
    }
  }
  return descriptors;
}

export function substituteSqlParameters(sql: string, values: Record<string, SqlParameterInput>, options?: SqlParameterOptions): string {
  const occurrences = findSqlParameterOccurrences(sql, options);
  if (!occurrences.length) return sql;
  const decodeMyBatisEntities = occurrences.some((occurrence) => occurrence.syntax === "mybatis");

  let result = "";
  let cursor = 0;
  for (const occurrence of occurrences) {
    result += sql.slice(cursor, occurrence.start);
    if (occurrence.replacement === "mybatis-where" && occurrence.where) {
      result += renderMyBatisWhere(occurrence.where, values, options);
      cursor = occurrence.end;
      continue;
    }
    const input = values[occurrence.key] ?? { kind: "string", value: "" };
    if (occurrence.replacement === "mybatis-foreach" && occurrence.foreach) {
      result += renderMyBatisForeach(occurrence.foreach, input, values, options);
      cursor = occurrence.end;
      continue;
    }
    // An empty Raw SQL value means that this placeholder is intentionally left
    // unresolved, rather than replaced with an empty string or NULL.
    if (input.kind === "raw" && !input.value.trim()) {
      result += occurrence.token;
      cursor = occurrence.end;
      continue;
    }
    // Embedded placeholders stay inside the surrounding SQL string, so their value
    // must be escaped as text instead of being wrapped in a second SQL literal.
    result += occurrence.replacement === "string-fragment" ? sqlParameterStringFragment(input) : occurrence.replacement === "quoted-string" ? sqlParameterQuotedString(input) : sqlParameterLiteral(input);
    cursor = occurrence.end;
  }
  result += sql.slice(cursor);
  return decodeMyBatisEntities ? decodeMyBatisXmlComparisonEntities(result, options?.databaseType) : result;
}

const MYBATIS_WHERE_LEADING_CONJUNCTION_RE = /^(?:AND|OR)\s+/i;

function renderMyBatisWhere(where: MyBatisWhere, values: Record<string, SqlParameterInput>, options?: SqlParameterOptions): string {
  const body = substituteSqlParameters(where.body, values, options).trim();
  if (!body) return "";
  return `WHERE ${body.replace(MYBATIS_WHERE_LEADING_CONJUNCTION_RE, "")}`;
}

function renderMyBatisForeach(foreach: MyBatisForeach, input: SqlParameterInput, values: Record<string, SqlParameterInput>, options?: SqlParameterOptions): string {
  const items = parseSqlParameterList(input.value);
  if (items.length === 0) return `${foreach.open}NULL${foreach.close}`;

  const renderedItems = items.map((item, index) => {
    const itemInput: SqlParameterInput = item === null ? { kind: "null", value: "NULL" } : { kind: input.kind, value: String(item) };
    const iterationValues = { ...values, [foreach.item]: itemInput };
    if (foreach.index) iterationValues[foreach.index] = { kind: "number", value: String(index) };
    return substituteSqlParameters(foreach.body, iterationValues, options);
  });
  return `${foreach.open}${renderedItems.join(foreach.separator)}${foreach.close}`;
}

function parseSqlParameterList(raw: string): Array<string | number | boolean | null> {
  const value = raw.trim();
  if (!value) return [];

  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) return parsed;
    } catch {
      return [];
    }
    return [];
  }

  return splitCommaSeparatedValues(value).map(unquoteListValue);
}

function splitCommaSeparatedValues(value: string): string[] {
  const items: string[] = [];
  let start = 0;
  let quote = "";

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < value.length) i += 1;
      else if (ch === quote) {
        if (value[i + 1] === quote) i += 1;
        else quote = "";
      }
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === ",") {
      items.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  items.push(value.slice(start).trim());
  return items;
}

function unquoteListValue(value: string): string {
  if (value.length < 2 || value[0] !== value[value.length - 1] || (value[0] !== "'" && value[0] !== '"')) return value;
  const quote = value[0];
  const inner = value.slice(1, -1);
  if (quote === "'") return inner.replace(/''/g, "'");
  try {
    return JSON.parse(value);
  } catch {
    return inner.replace(/""/g, '"');
  }
}

function decodeMyBatisXmlComparisonEntities(sql: string, databaseType?: DatabaseType): string {
  let result = "";
  let cursor = 0;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(sql, i, ch);
      continue;
    }
    if (ch === "[") {
      i = skipBracketIdentifier(sql, i, databaseType);
      continue;
    }
    if (ch === "-" && next === "-") {
      i = skipLine(sql, i + 2);
      continue;
    }
    if (ch === "/" && next === "*") {
      i = skipBlockComment(sql, i + 2);
      continue;
    }
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
      continue;
    }
    if (ch === "$") {
      const marker = readDollarQuoteMarker(sql, i);
      if (marker) {
        const end = sql.indexOf(marker, i + marker.length);
        i = end === -1 ? sql.length : end + marker.length;
        continue;
      }
    }

    const replacement = sql.startsWith("&lt;", i) ? "<" : sql.startsWith("&gt;", i) ? ">" : "";
    if (replacement) {
      result += sql.slice(cursor, i) + replacement;
      i += 4;
      cursor = i;
      continue;
    }
    i += 1;
  }

  return result + sql.slice(cursor);
}

export function sqlParameterLiteral(input: SqlParameterInput): string {
  if (input.kind === "null") return "NULL";
  const raw = input.value;
  if (input.kind === "raw") return raw.trim() || "NULL";
  if (input.kind === "number") return raw.trim() || "NULL";
  if (input.kind === "boolean") return normalizeBooleanLiteral(raw);
  return quoteSqlString(raw);
}

function findSqlParameterOccurrences(sql: string, options?: SqlParameterOptions): ParameterOccurrence[] {
  const occurrences: ParameterOccurrence[] = [];
  const databaseType = options?.databaseType;
  const nativeSqlServerParameters = collectNativeSqlServerParameters(sql, databaseType);
  const supportsNamedParameters = databaseType !== "saphana";
  const enabledSyntaxes = options?.enabledSyntaxes ? new Set(options.enabledSyntaxes) : null;
  const isSyntaxEnabled = (syntax: SqlParameterSyntax) => !enabledSyntaxes || enabledSyntaxes.has(syntax);
  const complexTypeFieldSeparators = supportsNamedParameters && isSyntaxEnabled("named") ? collectComplexTypeFieldSeparators(sql, databaseType) : new Set<number>();
  const duckDbStructFieldSeparators = supportsNamedParameters && isSyntaxEnabled("named") && databaseType === "duckdb" ? collectDuckDbStructFieldSeparators(sql) : new Set<number>();
  const triggerPseudoRecordFieldStarts = supportsNamedParameters && isSyntaxEnabled("named") ? collectTriggerPseudoRecordFieldStarts(sql, databaseType) : new Set<number>();
  let i = 0;
  let dollarQuoteEnd = "";
  let positionalIndex = 0;
  let parenthesisDepth = 0;
  const postgresBracketStack: Array<{ constructor: boolean; parenthesisDepth: number }> = [];

  while (i < sql.length) {
    if (dollarQuoteEnd) {
      const end = sql.indexOf(dollarQuoteEnd, i);
      if (end === -1) break;
      i = end + dollarQuoteEnd.length;
      dollarQuoteEnd = "";
      continue;
    }

    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "<" && isSyntaxEnabled("mybatis")) {
      const foreach = readMyBatisForeachAt(sql, i, databaseType);
      if (foreach) {
        occurrences.push({
          key: foreach.collection,
          name: foreach.collection,
          syntax: "mybatis",
          token: "<foreach>",
          collection: true,
          replacement: "mybatis-foreach",
          foreach: foreach.render,
          start: i,
          end: foreach.end,
        });
        i = foreach.end;
        continue;
      }
      const where = readMyBatisWhereAt(sql, i);
      if (where) {
        occurrences.push({
          key: "",
          name: "",
          syntax: "mybatis",
          token: "<where>",
          replacement: "mybatis-where",
          where: { body: where.body },
          start: i,
          end: where.end,
        });
        i = where.end;
        continue;
      }
    }

    if (ch === "'" || ch === '"') {
      const quoted = tryReadQuotedBracedPlaceholder(sql, i, ch, isSyntaxEnabled);
      if (quoted) {
        occurrences.push(quoted);
        i = quoted.end;
        continue;
      }
      const quotedEnd = skipQuoted(sql, i, ch);
      // Double quotes can delimit identifiers, so only ordinary single-quoted
      // values opt into embedded interpolation.
      if (ch === "'" && !hasSqlStringLiteralPrefix(sql, i)) {
        occurrences.push(...collectEmbeddedQuotedBracedPlaceholders(sql, i + 1, quotedEnd, isSyntaxEnabled));
      }
      i = quotedEnd;
      continue;
    }
    if (ch === "`") {
      i = skipQuoted(sql, i, ch);
      continue;
    }
    if (databaseType === "postgres" && ch === "(") {
      parenthesisDepth += 1;
      i += 1;
      continue;
    }
    if (databaseType === "postgres" && ch === ")") {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      i += 1;
      continue;
    }
    if (ch === "[") {
      if (databaseType === "postgres") {
        postgresBracketStack.push({
          constructor: isPostgresArrayConstructorBracket(sql, i, postgresBracketStack[postgresBracketStack.length - 1]?.constructor ?? false),
          parenthesisDepth,
        });
        i += 1;
        continue;
      }
      i = skipBracketIdentifier(sql, i, databaseType);
      continue;
    }
    if (databaseType === "postgres" && ch === "]") {
      postgresBracketStack.pop();
      i += 1;
      continue;
    }
    if (ch === "-" && next === "-") {
      i = skipLine(sql, i + 2);
      continue;
    }
    if (ch === "/" && next === "*") {
      i = skipBlockComment(sql, i + 2);
      continue;
    }
    if (ch === "?" && isSyntaxEnabled("positional")) {
      if (isPostgresQuestionMarkOperator(sql, i, options?.databaseType)) {
        i += 1;
        continue;
      }
      positionalIndex += 1;
      const key = `?${positionalIndex}`;
      occurrences.push({ key, name: key, syntax: "positional", token: "?", start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === ":" && supportsNamedParameters && isSyntaxEnabled("named")) {
      const name = readParameterName(sql, i + 1);
      if (
        name &&
        sql[i - 1] !== ":" &&
        sql[i + 1] !== "=" &&
        !complexTypeFieldSeparators.has(i) &&
        !duckDbStructFieldSeparators.has(i) &&
        !isPostgresSliceSeparator(postgresBracketStack, parenthesisDepth) &&
        !isDuckDbCompactPrefixAliasSeparator(sql, i, options?.databaseType) &&
        !triggerPseudoRecordFieldStarts.has(i) &&
        !isMysqlRoutineLabelSeparator(sql, i, name, options?.databaseType)
      ) {
        occurrences.push({
          key: name,
          name,
          syntax: "named",
          token: sql.slice(i, i + 1 + name.length),
          start: i,
          end: i + 1 + name.length,
        });
        i += 1 + name.length;
        continue;
      }
    }
    if ((ch === "$" || ch === "#") && next === "{") {
      const parameter = readSqlBracedParameterAt(sql, i, options);
      if (parameter) {
        occurrences.push(parameter);
        i = parameter.end;
        continue;
      }
    }
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
      continue;
    }
    if (ch === "@" && isSyntaxEnabled("sqlserver")) {
      const name = readParameterName(sql, i + 1);
      if (name && next !== "@" && sql[i - 1] !== "@" && !isOracleDatabaseLinkMarker(sql, i, options?.databaseType) && !isJdbcxMcpScopedPackage(sql, i, i + 1 + name.length) && !nativeSqlServerParameters.declared.has(name.toLowerCase()) && !nativeSqlServerParameters.ignoredStarts.has(i)) {
        occurrences.push({
          key: name,
          name,
          syntax: "sqlserver",
          token: sql.slice(i, i + 1 + name.length),
          start: i,
          end: i + 1 + name.length,
        });
        i += 1 + name.length;
        continue;
      }
    }
    if (ch === "$") {
      const marker = readDollarQuoteMarker(sql, i);
      if (marker) {
        dollarQuoteEnd = marker;
        i += marker.length;
        continue;
      }
    }
    i += 1;
  }

  return occurrences;
}

function isMysqlRoutineLabelSeparator(sql: string, colonIndex: number, followingName: string, databaseType?: DatabaseType): boolean {
  if (databaseType !== "mysql" || !MYSQL_ROUTINE_LABEL_STATEMENTS.has(followingName.toLowerCase())) return false;

  const label = sql.slice(0, colonIndex).match(MYSQL_ROUTINE_LABEL_RE);
  if (!label) return false;
  const labelStart = colonIndex - label[0].length;
  const prefix = sql.slice(0, labelStart).trimEnd();
  return prefix.length === 0 || prefix.endsWith(";") || MYSQL_ROUTINE_LABEL_CONTEXTS.has(previousKeyword(sql, labelStart));
}

function readMyBatisForeachAt(sql: string, start: number, databaseType?: DatabaseType): { collection: string; render: MyBatisForeach; end: number } | null {
  if (!/^<foreach(?:\s|>)/i.test(sql.slice(start))) return null;
  const openingEnd = findXmlTagEnd(sql, start);
  if (openingEnd === -1) return null;
  const attributes = parseXmlAttributes(sql.slice(start + "<foreach".length, openingEnd));
  if (!attributes) return null;

  const collection = attributes.get("collection")?.trim() ?? "";
  const item = attributes.get("item")?.trim() ?? "";
  const index = attributes.get("index")?.trim();
  if (!PARAMETER_NAME_RE.test(collection) || !PARAMETER_NAME_RE.test(item) || (index !== undefined && !PARAMETER_NAME_RE.test(index))) return null;

  const close = findMatchingXmlTagClose(sql, openingEnd + 1, "foreach", databaseType);
  if (!close) return null;
  return {
    collection,
    render: {
      item,
      ...(index ? { index } : {}),
      open: attributes.get("open") ?? "",
      separator: attributes.get("separator") ?? "",
      close: attributes.get("close") ?? "",
      body: sql.slice(openingEnd + 1, close.start),
    },
    end: close.end,
  };
}

function readMyBatisWhereAt(sql: string, start: number): { body: string; end: number } | null {
  if (!/^<where(?:\s|>)/i.test(sql.slice(start))) return null;
  const openingEnd = findXmlTagEnd(sql, start);
  if (openingEnd === -1) return null;

  const close = findMatchingXmlTagClose(sql, openingEnd + 1, "where");
  if (!close) return null;
  return { body: sql.slice(openingEnd + 1, close.start), end: close.end };
}

function findXmlTagEnd(source: string, start: number): number {
  let quote = "";
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === ">") return i;
  }
  return -1;
}

function parseXmlAttributes(source: string): Map<string, string> | null {
  const attributes = new Map<string, string>();
  let i = 0;
  while (i < source.length) {
    while (/\s/.test(source[i] ?? "")) i += 1;
    if (i >= source.length) break;

    const nameStart = i;
    while (/[\w:-]/.test(source[i] ?? "")) i += 1;
    if (i === nameStart) return null;
    const name = source.slice(nameStart, i).toLowerCase();
    while (/\s/.test(source[i] ?? "")) i += 1;
    if (source[i] !== "=") return null;
    i += 1;
    while (/\s/.test(source[i] ?? "")) i += 1;
    const quote = source[i];
    if (quote !== "'" && quote !== '"') return null;
    const valueStart = ++i;
    while (i < source.length && source[i] !== quote) i += 1;
    if (i >= source.length) return null;
    attributes.set(name, decodeXmlAttribute(source.slice(valueStart, i)));
    i += 1;
  }
  return attributes;
}

function decodeXmlAttribute(value: string): string {
  return value.replace(/&(?:lt|gt|amp|quot|apos);/g, (entity) => ({ "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" })[entity] ?? entity);
}

function findMatchingXmlTagClose(sql: string, start: number, tagName: string, databaseType?: DatabaseType): { start: number; end: number } | null {
  let depth = 1;
  let i = start;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(sql, i, ch);
      continue;
    }
    if (ch === "[") {
      i = skipBracketIdentifier(sql, i, databaseType);
      continue;
    }
    if (ch === "-" && next === "-") {
      i = skipLine(sql, i + 2);
      continue;
    }
    if (ch === "/" && next === "*") {
      i = skipBlockComment(sql, i + 2);
      continue;
    }
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
      continue;
    }
    if (ch === "$") {
      const marker = readDollarQuoteMarker(sql, i);
      if (marker) {
        const end = sql.indexOf(marker, i + marker.length);
        i = end === -1 ? sql.length : end + marker.length;
        continue;
      }
    }
    if (ch === "<") {
      const tag = readXmlTagAt(sql, i, tagName);
      if (tag) {
        depth += tag.closing ? -1 : 1;
        if (depth === 0) return { start: i, end: tag.end };
        i = tag.end;
        continue;
      }
    }
    i += 1;
  }
  return null;
}

function readXmlTagAt(sql: string, start: number, tagName: string): { closing: boolean; end: number } | null {
  const closing = sql[start + 1] === "/";
  const nameStart = start + (closing ? 2 : 1);
  if (sql.slice(nameStart, nameStart + tagName.length).toLowerCase() !== tagName) return null;
  const boundary = sql[nameStart + tagName.length];
  if (boundary !== ">" && !/\s/.test(boundary ?? "")) return null;
  const tagEnd = findXmlTagEnd(sql, start);
  return tagEnd === -1 ? null : { closing, end: tagEnd + 1 };
}

function isDuckDbCompactPrefixAliasSeparator(sql: string, index: number, databaseType?: DatabaseType): boolean {
  if (databaseType !== "duckdb") return false;
  const previous = sql[index - 1] ?? "";
  return PARAMETER_NAME_CHAR_RE.test(previous) || previous === '"';
}

function isOracleDatabaseLinkMarker(sql: string, index: number, databaseType: DatabaseType | undefined): boolean {
  if (databaseType !== "oracle" || index === 0) return false;
  const previous = sql[index - 1];
  return PARAMETER_NAME_CHAR_RE.test(previous) || previous === "$" || previous === "#" || previous === '"';
}

function isPostgresQuestionMarkOperator(sql: string, index: number, databaseType: DatabaseType | undefined): boolean {
  if (databaseType !== "postgres") return false;
  if (sql[index - 1] === "@" || sql[index + 1] === "|" || sql[index + 1] === "&") return true;

  const previousIndex = previousSqlSignificantIndex(sql, index);
  if (previousIndex < 0 || !canEndPostgresExpression(sql, previousIndex)) return false;

  const nextIndex = skipSqlWhitespaceAndComments(sql, index + 1);
  if (nextIndex >= sql.length) return false;
  const next = sql[nextIndex];
  if (next === "'" || next === '"' || next === "`" || next === "[" || next === "(" || next === "$" || next === ":" || next === "#" || next === "@" || next === "?" || next === "+" || next === "-") return true;
  if (!PARAMETER_NAME_CHAR_RE.test(next)) return false;

  let end = nextIndex + 1;
  while (end < sql.length && PARAMETER_NAME_CHAR_RE.test(sql[end])) end += 1;
  return !POSTGRES_QUESTION_OPERATOR_TRAILING_KEYWORDS.has(sql.slice(nextIndex, end).toLowerCase());
}

function previousSqlSignificantIndex(sql: string, start: number): number {
  let index = start - 1;
  while (index >= 0) {
    while (index >= 0 && /\s/.test(sql[index])) index -= 1;
    if (index >= 1 && sql[index - 1] === "*" && sql[index] === "/") {
      const commentStart = sql.lastIndexOf("/*", index - 1);
      if (commentStart >= 0) {
        index = commentStart - 1;
        continue;
      }
    }
    return index;
  }
  return -1;
}

function canEndPostgresExpression(sql: string, end: number): boolean {
  const previous = sql[end];
  if (previous === ")" || previous === "]" || previous === "}" || previous === "'" || previous === '"' || previous === "`" || previous === "$") return true;
  if (!PARAMETER_NAME_CHAR_RE.test(previous)) return false;

  let start = end;
  while (start > 0 && PARAMETER_NAME_CHAR_RE.test(sql[start - 1])) start -= 1;
  return !POSTGRES_QUESTION_PARAMETER_PREFIX_KEYWORDS.has(sql.slice(start, end + 1).toLowerCase());
}

function collectDuckDbStructFieldSeparators(sql: string): Set<number> {
  const separators = new Set<number>();
  const contexts: DuckDbStructLiteralContext[] = [];
  let cursor = 0;
  let dollarQuoteEnd = "";

  while (cursor < sql.length) {
    if (dollarQuoteEnd) {
      const end = sql.indexOf(dollarQuoteEnd, cursor);
      if (end === -1) break;
      cursor = end + dollarQuoteEnd.length;
      dollarQuoteEnd = "";
      continue;
    }

    const ch = sql[cursor];
    const next = sql[cursor + 1];
    if (ch === "'" || ch === '"' || ch === "`") {
      cursor = skipQuoted(sql, cursor, ch);
      continue;
    }
    if (ch === "-" && next === "-") {
      cursor = skipLine(sql, cursor + 2);
      continue;
    }
    if (ch === "/" && next === "*") {
      cursor = skipBlockComment(sql, cursor + 2);
      continue;
    }
    if (isHashLineComment(sql, cursor)) {
      cursor = skipLine(sql, cursor + 1);
      continue;
    }
    if (ch === "$") {
      const marker = readDollarQuoteMarker(sql, cursor);
      if (marker) {
        dollarQuoteEnd = marker;
        cursor += marker.length;
        continue;
      }
    }
    if (ch === "{") {
      const separator = readDuckDbStructFieldSeparator(sql, cursor + 1);
      contexts.push({
        bracketDepth: 0,
        parenthesisDepth: 0,
        separators: new Set(separator === null ? [] : [separator]),
        valid: separator !== null,
      });
      cursor += 1;
      continue;
    }
    if (ch === "}") {
      const context = contexts.pop();
      if (context?.valid) {
        const parent = contexts[contexts.length - 1];
        const destination = parent ? parent.separators : separators;
        for (const separator of context.separators) destination.add(separator);
      }
      cursor += 1;
      continue;
    }

    const context = contexts[contexts.length - 1];
    if (!context) {
      cursor += 1;
      continue;
    }
    if (ch === "(") context.parenthesisDepth += 1;
    else if (ch === ")" && context.parenthesisDepth > 0) context.parenthesisDepth -= 1;
    else if (ch === "[") context.bracketDepth += 1;
    else if (ch === "]" && context.bracketDepth > 0) context.bracketDepth -= 1;
    else if (ch === "," && context.valid && context.parenthesisDepth === 0 && context.bracketDepth === 0) {
      const separator = readDuckDbStructFieldSeparator(sql, cursor + 1);
      if (separator !== null) context.separators.add(separator);
    }
    cursor += 1;
  }

  return separators;
}

function readDuckDbStructFieldSeparator(sql: string, start: number): number | null {
  const fieldStart = skipSqlWhitespaceAndComments(sql, start);
  const ch = sql[fieldStart];
  let fieldNameEnd = fieldStart;

  if (ch === "'" || ch === '"' || ch === "`") fieldNameEnd = skipQuoted(sql, fieldStart, ch);
  else {
    const fieldName = readParameterName(sql, fieldStart);
    if (!fieldName) return null;
    fieldNameEnd += fieldName.length;
  }

  const separator = skipSqlWhitespaceAndComments(sql, fieldNameEnd);
  return sql[separator] === ":" ? separator : null;
}

// Oracle and Dameng expose trigger rows through colon-prefixed pseudo-records,
// unlike PostgreSQL's unprefixed NEW/OLD records. Keep ordinary :name binds enabled.
function collectTriggerPseudoRecordFieldStarts(sql: string, databaseType?: DatabaseType): Set<number> {
  const starts = new Set<number>();
  const defaults = triggerPseudoRecordDefaults(databaseType);
  if (!defaults) return starts;

  let aliases: Set<string> | null = null;
  let i = 0;
  let dollarQuoteEnd = "";

  while (i < sql.length) {
    if (dollarQuoteEnd) {
      const end = sql.indexOf(dollarQuoteEnd, i);
      if (end === -1) break;
      i = end + dollarQuoteEnd.length;
      dollarQuoteEnd = "";
      continue;
    }

    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(sql, i, ch);
      continue;
    }
    if (ch === "[") {
      i = skipBracketIdentifier(sql, i, databaseType);
      continue;
    }
    if (ch === "-" && next === "-") {
      i = skipLine(sql, i + 2);
      continue;
    }
    if (ch === "/" && next === "*") {
      i = skipBlockComment(sql, i + 2);
      continue;
    }
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
      continue;
    }
    if (ch === "$") {
      const marker = readDollarQuoteMarker(sql, i);
      if (marker) {
        dollarQuoteEnd = marker;
        i += marker.length;
        continue;
      }
    }

    if (aliases && ch === "/" && isStandaloneSlashDelimiter(sql, i)) {
      aliases = null;
      i += 1;
      continue;
    }
    if (!aliases && matchesWord(sql, i, "create")) {
      const triggerStart = readCreateTriggerEnd(sql, i);
      if (triggerStart !== null) {
        aliases = new Set(defaults);
        i = triggerStart;
        continue;
      }
    }
    if (aliases && matchesWord(sql, i, "referencing")) {
      i = collectTriggerReferencingAliases(sql, i + "referencing".length, aliases, defaults);
      continue;
    }
    if (aliases && ch === ":") {
      const name = readParameterName(sql, i + 1);
      if (name && aliases.has(name.toLowerCase()) && isTriggerPseudoRecordFieldReference(sql, i + 1 + name.length)) {
        starts.add(i);
        i += 1 + name.length;
        continue;
      }
    }
    i += 1;
  }

  return starts;
}

function triggerPseudoRecordDefaults(databaseType?: DatabaseType): readonly TriggerPseudoRecordName[] | null {
  if (databaseType === "oracle") return ["new", "old", "parent"];
  if (databaseType === "dameng") return ["new", "old", "eventinfo"];
  return null;
}

function readCreateTriggerEnd(sql: string, start: number): number | null {
  let keyword = readNextKeyword(sql, start + "create".length);
  if (!keyword) return null;
  if (keyword.word === "or") {
    keyword = readNextKeyword(sql, keyword.end);
    if (keyword?.word !== "replace") return null;
    keyword = readNextKeyword(sql, keyword.end);
  }
  return keyword?.word === "trigger" ? keyword.end : null;
}

function collectTriggerReferencingAliases(sql: string, start: number, aliases: Set<string>, defaults: readonly TriggerPseudoRecordName[]): number {
  const supported = new Set<string>(defaults);
  let i = start;

  while (i < sql.length) {
    const source = readNextKeyword(sql, i);
    if (!source || isTriggerReferencingBoundary(source.word)) return i;
    if (!supported.has(source.word)) {
      i = source.end;
      continue;
    }

    let alias = readNextKeyword(sql, source.end);
    if (alias?.word === "row") alias = readNextKeyword(sql, alias.end);
    if (alias?.word === "as") alias = readNextKeyword(sql, alias.end);
    if (!alias || supported.has(alias.word) || isTriggerReferencingBoundary(alias.word)) {
      i = source.end;
      continue;
    }

    aliases.add(alias.word);
    i = alias.end;
  }

  return i;
}

function isTriggerReferencingBoundary(word: string): boolean {
  return ["before", "after", "instead", "for", "when", "begin", "declare", "call", "enable", "disable"].includes(word);
}

function isTriggerPseudoRecordFieldReference(sql: string, nameEnd: number): boolean {
  if (sql[nameEnd] !== ".") return false;
  const fieldStart = nameEnd + 1;
  return PARAMETER_NAME_START_RE.test(sql[fieldStart] ?? "") || sql[fieldStart] === '"';
}

function isStandaloneSlashDelimiter(sql: string, start: number): boolean {
  let before = start - 1;
  while (before >= 0 && (sql[before] === " " || sql[before] === "\t" || sql[before] === "\r")) before -= 1;
  if (before >= 0 && sql[before] !== "\n") return false;

  let after = start + 1;
  while (after < sql.length && (sql[after] === " " || sql[after] === "\t" || sql[after] === "\r")) after += 1;
  return after === sql.length || sql[after] === "\n";
}

// JDBCX MCP commands accept npm scoped packages in their unquoted args value,
// for example `args=-y @modelcontextprotocol/server-everything`. The `@scope`
// prefix is command data, not a SQL Server-style template parameter.
function isJdbcxMcpScopedPackage(sql: string, start: number, nameEnd: number): boolean {
  if (sql[nameEnd] !== "/" || !/[\p{L}\p{N}_.-]/u.test(sql[nameEnd + 1] ?? "")) return false;

  const blockStart = sql.lastIndexOf("{{", start);
  if (blockStart === -1 || sql.lastIndexOf("}}", start) > blockStart) return false;

  const extensionPrefix = sql.slice(blockStart + 2, start);
  return /^\s*mcp\s*\(/i.test(extensionPrefix) && /(?:^|[,\s])args\s*=[^,]*$/i.test(extensionPrefix);
}

// Doris-style complex types use colons between field names and types; those are not bind parameters.
function collectComplexTypeFieldSeparators(sql: string, databaseType?: DatabaseType): Set<number> {
  const separators = new Set<number>();
  let i = 0;
  let dollarQuoteEnd = "";

  while (i < sql.length) {
    if (dollarQuoteEnd) {
      const end = sql.indexOf(dollarQuoteEnd, i);
      if (end === -1) break;
      i = end + dollarQuoteEnd.length;
      dollarQuoteEnd = "";
      continue;
    }

    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(sql, i, ch);
      continue;
    }
    if (ch === "[") {
      i = skipBracketIdentifier(sql, i, databaseType);
      continue;
    }
    if (ch === "-" && next === "-") {
      i = skipLine(sql, i + 2);
      continue;
    }
    if (ch === "/" && next === "*") {
      i = skipBlockComment(sql, i + 2);
      continue;
    }
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
      continue;
    }
    if (ch === "$") {
      const marker = readDollarQuoteMarker(sql, i);
      if (marker) {
        dollarQuoteEnd = marker;
        i += marker.length;
        continue;
      }
    }
    const declaration = readComplexTypeDeclaration(sql, i);
    if (declaration) {
      i = collectComplexTypeFieldSeparatorsInDeclaration(sql, declaration.openingBracket + 1, declaration.kind, separators, databaseType) + 1;
      continue;
    }
    i += 1;
  }

  return separators;
}

function collectComplexTypeFieldSeparatorsInDeclaration(sql: string, start: number, kind: ComplexTypeDeclarationKind, separators: Set<number>, databaseType?: DatabaseType): number {
  let i = start;
  let genericDepth = 0;
  let parenthesisDepth = 0;
  let expectsFieldName = true;

  while (i < sql.length) {
    if (expectsFieldName && genericDepth === 0 && parenthesisDepth === 0) {
      const fieldStart = skipSqlWhitespaceAndComments(sql, i);
      if (fieldStart !== i) {
        i = fieldStart;
        continue;
      }
      if (isLineStatementStart(sql, i) && isSqlStatementKeyword(sql, i)) return i;
      const fieldNameEnd = readComplexTypeFieldNameEnd(sql, i, kind, databaseType);
      if (fieldNameEnd > i) {
        const separator = skipSqlWhitespaceAndComments(sql, fieldNameEnd);
        if (sql[separator] === ":") {
          separators.add(separator);
          i = separator + 1;
          expectsFieldName = false;
          continue;
        }
        i = fieldNameEnd;
        expectsFieldName = false;
        continue;
      }
    }

    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(sql, i, ch);
      continue;
    }
    if (ch === "[") {
      i = skipBracketIdentifier(sql, i, databaseType);
      continue;
    }
    if (ch === "-" && next === "-") {
      i = skipLine(sql, i + 2);
      continue;
    }
    if (ch === "/" && next === "*") {
      i = skipBlockComment(sql, i + 2);
      continue;
    }
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
      continue;
    }
    const declaration = readComplexTypeDeclaration(sql, i);
    if (declaration) {
      i = collectComplexTypeFieldSeparatorsInDeclaration(sql, declaration.openingBracket + 1, declaration.kind, separators, databaseType) + 1;
      continue;
    }
    if (ch === ";" && genericDepth === 0 && parenthesisDepth === 0) return i;
    if (ch === "<") {
      genericDepth += 1;
      i += 1;
      continue;
    }
    if (ch === ">") {
      if (genericDepth === 0 && parenthesisDepth === 0) return i;
      if (genericDepth > 0) genericDepth -= 1;
      i += 1;
      continue;
    }
    if (ch === "(") {
      parenthesisDepth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      if (parenthesisDepth > 0) parenthesisDepth -= 1;
      i += 1;
      continue;
    }
    if (ch === "," && genericDepth === 0 && parenthesisDepth === 0) {
      expectsFieldName = true;
    }
    i += 1;
  }

  return sql.length;
}

function readComplexTypeDeclaration(sql: string, start: number): { kind: ComplexTypeDeclarationKind; openingBracket: number } | null {
  const kind: ComplexTypeDeclarationKind | null = matchesWord(sql, start, "struct") ? "struct" : matchesWord(sql, start, "variant") ? "variant" : null;
  if (!kind) return null;

  const openingBracket = skipSqlWhitespaceAndComments(sql, start + kind.length);
  return sql[openingBracket] === "<" ? { kind, openingBracket } : null;
}

function readComplexTypeFieldNameEnd(sql: string, start: number, kind: ComplexTypeDeclarationKind, databaseType?: DatabaseType): number {
  if (kind === "variant") return readVariantFieldNameEnd(sql, start);

  const ch = sql[start];
  if (ch === '"' || ch === "`") return skipQuoted(sql, start, ch);
  if (ch === "[") return skipBracketIdentifier(sql, start, databaseType);
  if (!PARAMETER_NAME_START_RE.test(ch ?? "")) return start;

  let i = start + 1;
  while (i < sql.length && PARAMETER_NAME_CHAR_RE.test(sql[i])) i += 1;
  return i;
}

function readVariantFieldNameEnd(sql: string, start: number): number {
  let i = start;
  const modifier = matchesWord(sql, i, "match_name") ? "match_name" : matchesWord(sql, i, "match_name_glob") ? "match_name_glob" : "";
  if (modifier) i = skipSqlWhitespaceAndComments(sql, i + modifier.length);
  return sql[i] === "'" ? skipQuoted(sql, i, "'") : start;
}

function skipSqlWhitespaceAndComments(sql: string, start: number): number {
  let i = start;
  while (i < sql.length) {
    while (i < sql.length && /\s/.test(sql[i])) i += 1;
    if (sql[i] === "-" && sql[i + 1] === "-") {
      i = skipLine(sql, i + 2);
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      i = skipBlockComment(sql, i + 2);
      continue;
    }
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
      continue;
    }
    break;
  }
  return i;
}

function collectNativeSqlServerParameters(sql: string, databaseType?: DatabaseType): { declared: Set<string>; ignoredStarts: Set<number> } {
  const declared = new Set<string>();
  const ignoredStarts = new Set<number>();
  let i = 0;
  let dollarQuoteEnd = "";

  while (i < sql.length) {
    if (dollarQuoteEnd) {
      const end = sql.indexOf(dollarQuoteEnd, i);
      if (end === -1) break;
      i = end + dollarQuoteEnd.length;
      dollarQuoteEnd = "";
      continue;
    }

    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(sql, i, ch);
      continue;
    }
    if (ch === "[") {
      i = skipBracketIdentifier(sql, i, databaseType);
      continue;
    }
    if (ch === "-" && next === "-") {
      i = skipLine(sql, i + 2);
      continue;
    }
    if (ch === "/" && next === "*") {
      i = skipBlockComment(sql, i + 2);
      continue;
    }
    if (ch === "$") {
      const marker = readDollarQuoteMarker(sql, i);
      if (marker) {
        dollarQuoteEnd = marker;
        i += marker.length;
        continue;
      }
    }
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
      continue;
    }
    if (matchesWord(sql, i, "declare")) {
      i = collectDeclareStatementVariables(sql, i + "declare".length, declared, databaseType);
      continue;
    }
    if (matchesWord(sql, i, "set")) {
      i = collectSetStatementVariables(sql, i + "set".length, declared, databaseType);
      continue;
    }
    if (matchesWord(sql, i, "select")) {
      i = collectSelectAssignmentVariables(sql, i + "select".length, declared, databaseType);
      continue;
    }
    if ((matchesWord(sql, i, "create") || matchesWord(sql, i, "alter")) && isRoutineDefinitionStart(sql, i)) {
      i = collectRoutineDefinitionVariables(sql, i, declared, databaseType);
      continue;
    }
    if (matchesWord(sql, i, "exec") || matchesWord(sql, i, "execute")) {
      i = collectExecNamedArgumentStarts(sql, i + (matchesWord(sql, i, "exec") ? "exec".length : "execute".length), ignoredStarts, databaseType);
      continue;
    }
    i += 1;
  }

  return { declared, ignoredStarts };
}

function collectDeclareStatementVariables(sql: string, start: number, declared: Set<string>, databaseType?: DatabaseType): number {
  let i = start;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === ";") return i + 1;
    if (isLineStatementStart(sql, i) && isSqlStatementKeyword(sql, i)) return i;
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(sql, i, ch);
      continue;
    }
    if (ch === "[") {
      i = skipBracketIdentifier(sql, i, databaseType);
      continue;
    }
    if (ch === "-" && next === "-") {
      i = skipLine(sql, i + 2);
      continue;
    }
    if (ch === "/" && next === "*") {
      i = skipBlockComment(sql, i + 2);
      continue;
    }
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
      continue;
    }
    if (ch === "@") {
      const name = readParameterName(sql, i + 1);
      if (name && next !== "@" && sql[i - 1] !== "@") {
        declared.add(name.toLowerCase());
        i += 1 + name.length;
        continue;
      }
    }
    i += 1;
  }
  return i;
}

function collectSetStatementVariables(sql: string, start: number, declared: Set<string>, databaseType?: DatabaseType): number {
  let i = start;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === ";") return i + 1;
    if (isLineStatementStart(sql, i) && isSqlStatementKeyword(sql, i)) return i;
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(sql, i, ch);
      continue;
    }
    if (ch === "[") {
      i = skipBracketIdentifier(sql, i, databaseType);
      continue;
    }
    if (ch === "-" && next === "-") {
      i = skipLine(sql, i + 2);
      continue;
    }
    if (ch === "/" && next === "*") {
      i = skipBlockComment(sql, i + 2);
      continue;
    }
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
      continue;
    }
    if (ch === "@") {
      const name = readParameterName(sql, i + 1);
      if (name && next !== "@" && sql[i - 1] !== "@" && isSetAssignmentTarget(sql, i + 1 + name.length)) {
        declared.add(name.toLowerCase());
        i += 1 + name.length;
        continue;
      }
    }
    i += 1;
  }
  return i;
}

function collectSelectAssignmentVariables(sql: string, start: number, declared: Set<string>, databaseType?: DatabaseType): number {
  let i = start;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === ";") return i + 1;
    if (isLineStatementStart(sql, i) && isSqlStatementKeyword(sql, i)) return i;
    if (matchesWord(sql, i, "from")) return i;
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(sql, i, ch);
      continue;
    }
    if (ch === "[") {
      i = skipBracketIdentifier(sql, i, databaseType);
      continue;
    }
    if (ch === "-" && next === "-") {
      i = skipLine(sql, i + 2);
      continue;
    }
    if (ch === "/" && next === "*") {
      i = skipBlockComment(sql, i + 2);
      continue;
    }
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
      continue;
    }
    if (ch === "@") {
      const name = readParameterName(sql, i + 1);
      if (name && next !== "@" && sql[i - 1] !== "@" && isSetAssignmentTarget(sql, i + 1 + name.length)) {
        declared.add(name.toLowerCase());
        i += 1 + name.length;
        continue;
      }
    }
    i += 1;
  }
  return i;
}

function collectRoutineDefinitionVariables(sql: string, start: number, declared: Set<string>, databaseType?: DatabaseType): number {
  let i = start;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === ";") return i + 1;
    if (matchesWord(sql, i, "as") || matchesWord(sql, i, "returns")) return i;
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(sql, i, ch);
      continue;
    }
    if (ch === "[") {
      i = skipBracketIdentifier(sql, i, databaseType);
      continue;
    }
    if (ch === "-" && next === "-") {
      i = skipLine(sql, i + 2);
      continue;
    }
    if (ch === "/" && next === "*") {
      i = skipBlockComment(sql, i + 2);
      continue;
    }
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
      continue;
    }
    if (ch === "@") {
      const name = readParameterName(sql, i + 1);
      if (name && next !== "@" && sql[i - 1] !== "@") {
        declared.add(name.toLowerCase());
        i += 1 + name.length;
        continue;
      }
    }
    i += 1;
  }
  return i;
}

function collectExecNamedArgumentStarts(sql: string, start: number, ignoredStarts: Set<number>, databaseType?: DatabaseType): number {
  let i = start;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === ";") return i + 1;
    if (isLineStatementStart(sql, i) && isSqlStatementKeyword(sql, i)) return i;
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(sql, i, ch);
      continue;
    }
    if (ch === "[") {
      i = skipBracketIdentifier(sql, i, databaseType);
      continue;
    }
    if (ch === "-" && next === "-") {
      i = skipLine(sql, i + 2);
      continue;
    }
    if (ch === "/" && next === "*") {
      i = skipBlockComment(sql, i + 2);
      continue;
    }
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
      continue;
    }
    if (ch === "@") {
      const name = readParameterName(sql, i + 1);
      if (name && next !== "@" && sql[i - 1] !== "@" && isSetAssignmentTarget(sql, i + 1 + name.length)) {
        ignoredStarts.add(i);
        i += 1 + name.length;
        continue;
      }
    }
    i += 1;
  }
  return i;
}

function isRoutineDefinitionStart(sql: string, start: number): boolean {
  const keyword = matchesWord(sql, start, "create") ? "create" : matchesWord(sql, start, "alter") ? "alter" : "";
  if (!keyword) return false;

  let next = readNextKeyword(sql, start + keyword.length);
  if (!next) return false;
  if (keyword === "create" && next.word === "or") {
    const afterOr = readNextKeyword(sql, next.end);
    if (!afterOr || (afterOr.word !== "alter" && afterOr.word !== "replace")) return false;
    next = readNextKeyword(sql, afterOr.end);
    if (!next) return false;
  }
  return next.word === "procedure" || next.word === "proc" || next.word === "function";
}

function readNextKeyword(sql: string, start: number): { word: string; end: number } | null {
  let i = start;
  while (i < sql.length) {
    while (i < sql.length && /\s/.test(sql[i])) i += 1;
    if (sql[i] === "-" && sql[i + 1] === "-") {
      i = skipLine(sql, i + 2);
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      i = skipBlockComment(sql, i + 2);
      continue;
    }
    break;
  }
  if (!PARAMETER_NAME_START_RE.test(sql[i] ?? "")) return null;
  let end = i + 1;
  while (end < sql.length && PARAMETER_NAME_CHAR_RE.test(sql[end])) end += 1;
  return { word: sql.slice(i, end).toLowerCase(), end };
}

function isSetAssignmentTarget(sql: string, start: number): boolean {
  let i = start;
  while (i < sql.length && /\s/.test(sql[i])) i += 1;
  return sql[i] === "=" || (sql[i] === ":" && sql[i + 1] === "=");
}

function isLineStatementStart(sql: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && (sql[i] === " " || sql[i] === "\t" || sql[i] === "\r")) i -= 1;
  return i >= 0 && sql[i] === "\n";
}

function isSqlStatementKeyword(sql: string, start: number): boolean {
  return ["select", "with", "insert", "update", "delete", "merge", "exec", "execute", "set", "if", "while", "begin", "create", "alter", "drop", "truncate"].some((keyword) => matchesWord(sql, start, keyword));
}

function matchesWord(sql: string, start: number, word: string): boolean {
  const value = sql.slice(start, start + word.length);
  if (value.toLowerCase() !== word) return false;
  return !PARAMETER_NAME_CHAR_RE.test(sql[start - 1] ?? "") && !PARAMETER_NAME_CHAR_RE.test(sql[start + word.length] ?? "");
}

function readParameterName(sql: string, start: number): string {
  if (!PARAMETER_NAME_START_RE.test(sql[start] ?? "")) return "";
  let i = start + 1;
  while (i < sql.length && PARAMETER_NAME_CHAR_RE.test(sql[i])) i += 1;
  return sql.slice(start, i);
}

/** Match only unprefixed quote + exact `${name}`/`#{name}` + same quote. Leaves skipQuoted unchanged. */
function tryReadQuotedBracedPlaceholder(sql: string, start: number, quote: "'" | '"', isSyntaxEnabled: (syntax: SqlParameterSyntax) => boolean): ParameterOccurrence | null {
  if (sql[start] !== quote) return null;
  // Reject E'...', U&'...', B'...', X'...', N'...' — replacing the quoted span would leave the
  // prefix attached to a typed literal (e.g. E'${path}' → E'C:\new', B'${flag}' → BTRUE).
  if (hasSqlStringLiteralPrefix(sql, start)) return null;

  const open = sql.slice(start + 1, start + 3);
  let syntax: SqlParameterSyntax | null = null;
  if (open === "${") syntax = "shell";
  else if (open === "#{") syntax = "mybatis";
  else return null;
  if (!isSyntaxEnabled(syntax)) return null;

  const nameStart = start + 3;
  const closeBrace = sql.indexOf("}", nameStart);
  if (closeBrace === -1 || sql[closeBrace + 1] !== quote) return null;

  const name = sql.slice(nameStart, closeBrace).trim();
  if (!PARAMETER_NAME_RE.test(name)) return null;

  const end = closeBrace + 2;
  // The closing quote must be a real string terminator under the same rules as skipQuoted
  // (doubled quotes / backslash escapes). Otherwise '${value}''suffix' would match '${value}'.
  if (skipQuoted(sql, start, quote) !== end) return null;

  return {
    key: name,
    name,
    syntax,
    token: sql.slice(start, end),
    ...(quote === "\'" ? { replacement: "quoted-string" as const } : {}),
    start,
    end,
  };
}

function collectEmbeddedQuotedBracedPlaceholders(sql: string, contentStart: number, quotedEnd: number, isSyntaxEnabled: (syntax: SqlParameterSyntax) => boolean): ParameterOccurrence[] {
  const occurrences: ParameterOccurrence[] = [];
  const contentEnd = sql[quotedEnd - 1] === "'" ? quotedEnd - 1 : quotedEnd;
  let i = contentStart;

  while (i < contentEnd) {
    const ch = sql[i];
    const next = sql[i + 1];
    let syntax: SqlParameterSyntax | null = null;
    if (ch === "$" && next === "{") syntax = "shell";
    else if (ch === "#" && next === "{") syntax = "mybatis";
    if (!syntax || !isSyntaxEnabled(syntax)) {
      i += 1;
      continue;
    }

    const closeBrace = sql.indexOf("}", i + 2);
    if (closeBrace === -1 || closeBrace >= contentEnd) {
      i += 1;
      continue;
    }
    const name = sql.slice(i + 2, closeBrace).trim();
    if (!PARAMETER_NAME_RE.test(name)) {
      i += 1;
      continue;
    }

    occurrences.push({
      key: name,
      name,
      syntax,
      token: sql.slice(i, closeBrace + 1),
      start: i,
      end: closeBrace + 1,
      replacement: "string-fragment",
    });
    i = closeBrace + 1;
  }

  return occurrences;
}

/** True when `quoteStart` opens a prefixed literal such as E'...', U&'...', or MySQL _charset'...'. */
function hasSqlStringLiteralPrefix(sql: string, quoteStart: number): boolean {
  if (quoteStart <= 0) return false;

  if (quoteStart >= 2 && sql[quoteStart - 1] === "&" && (sql[quoteStart - 2] === "U" || sql[quoteStart - 2] === "u") && !PARAMETER_NAME_CHAR_RE.test(sql[quoteStart - 3] ?? "")) {
    return true;
  }

  // SQL dialects attach word-like introducers directly to the quote. Reject the
  // whole category so typed replacement cannot leave invalid prefixes such as
  // `_utf8mb4TRUE`, and so future introducers do not require another allowlist.
  return PARAMETER_NAME_CHAR_RE.test(sql[quoteStart - 1]);
}

function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === "\\" && quote === "'" && i + 1 < sql.length) {
      i += 2;
      continue;
    }
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

function skipBracketIdentifier(sql: string, start: number, databaseType?: DatabaseType): number {
  // PostgreSQL uses square brackets for ARRAY constructors and subscripts, not
  // for delimited identifiers. Leave the opening bracket in the lexical stream
  // so quoted array elements cannot corrupt the following SQL state.
  if (databaseType === "postgres") return start + 1;

  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === "]") {
      if (sql[i + 1] === "]") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

function skipLine(sql: string, start: number): number {
  const nextNewline = sql.indexOf("\n", start);
  return nextNewline === -1 ? sql.length : nextNewline + 1;
}

function skipBlockComment(sql: string, start: number): number {
  const end = sql.indexOf("*/", start);
  return end === -1 ? sql.length : end + 2;
}

function isHashLineComment(sql: string, start: number): boolean {
  if (sql[start] !== "#" || sql[start + 1] === "{") return false;
  // Keep SQL Server #temp table names parseable while treating other # tokens as MySQL-style comments.
  return !isSqlServerTempTableReference(sql, start);
}

function isSqlServerTempTableReference(sql: string, start: number): boolean {
  let nameStart = start + 1;
  if (sql[nameStart] === "#") nameStart += 1;
  if (!PARAMETER_NAME_START_RE.test(sql[nameStart] ?? "")) return false;

  const previous = previousKeyword(sql, start);
  return !!previous && SQL_SERVER_TEMP_TABLE_CONTEXT_KEYWORDS.has(previous);
}

function isPostgresArrayConstructorBracket(sql: string, start: number, parentIsConstructor: boolean): boolean {
  if (previousKeyword(sql, start) === "array") return true;
  if (!parentIsConstructor) return false;

  let previous = start - 1;
  while (previous >= 0 && /\s/.test(sql[previous])) previous -= 1;
  return sql[previous] === "[" || sql[previous] === ",";
}

function isPostgresSliceSeparator(stack: Array<{ constructor: boolean; parenthesisDepth: number }>, parenthesisDepth: number): boolean {
  const context = stack[stack.length - 1];
  return !!context && !context.constructor && context.parenthesisDepth === parenthesisDepth;
}

function previousKeyword(sql: string, start: number): string {
  let end = start - 1;
  while (end >= 0 && /\s/.test(sql[end])) end -= 1;
  let begin = end;
  while (begin >= 0 && PARAMETER_NAME_CHAR_RE.test(sql[begin])) begin -= 1;
  begin += 1;
  if (begin > end || !PARAMETER_NAME_START_RE.test(sql[begin] ?? "")) return "";
  return sql.slice(begin, end + 1).toLowerCase();
}

function readDollarQuoteMarker(sql: string, start: number): string {
  const match = sql.slice(start).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
  return match?.[0] ?? "";
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlParameterStringFragment(input: SqlParameterInput): string {
  return input.value.replace(/'/g, "''");
}

function sqlParameterQuotedString(input: SqlParameterInput): string {
  if (input.kind === "null" || ((input.kind === "number" || input.kind === "raw") && !input.value.trim())) return "NULL";
  return quoteSqlString(input.value);
}

function normalizeBooleanLiteral(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "t" || normalized === "yes" || normalized === "y" || normalized === "1") return "TRUE";
  if (normalized === "false" || normalized === "f" || normalized === "no" || normalized === "n" || normalized === "0") return "FALSE";
  return quoteSqlString(value);
}
