import { sqlSemanticDialectFor, resolveSqlDialectId } from "@/lib/sql/semantic/dialect";
import { tokenIsIdentifier, tokenizeSqlSemantic, unquoteSqlSemanticIdentifier } from "@/lib/sql/semantic/tokens";
import type { SqlSemanticBuildOptions, SqlSemanticSpan, SqlSemanticToken } from "@/lib/sql/semantic/types";
import type { SqlCompletionColumn, SqlCompletionTable } from "@/lib/sql/sqlCompletion";

export const MAX_LOCAL_SCHEMA_SQL_LENGTH = 250_000;

export interface SqlLocalSchemaColumn extends SqlCompletionColumn {
  nameQuoted: boolean;
  span: SqlSemanticSpan;
}

export interface SqlLocalSchemaTable extends SqlCompletionTable {
  columns: SqlLocalSchemaColumn[];
  nameQuoted: boolean;
  schemaQuoted?: boolean;
  statementSpan: SqlSemanticSpan;
}

export interface SqlLocalSchemaOverlay {
  tables: SqlLocalSchemaTable[];
}

interface QualifiedLocalName {
  parts: Array<{
    name: string;
    raw: string;
    quoted: boolean;
    span: SqlSemanticSpan;
  }>;
  nextIndex: number;
}

const CREATE_TABLE_MODIFIERS = new Set(["temp", "temporary", "unlogged"]);
const TABLE_CONSTRAINT_START = new Set(["constraint", "primary", "foreign", "unique", "check", "key", "index", "exclude", "like"]);
const COLUMN_CONSTRAINT_START = new Set(["primary", "references", "foreign", "unique", "check", "not", "null", "default", "generated", "identity", "auto_increment", "autoincrement", "collate", "comment"]);

export function buildSqlLocalSchemaOverlay(sql: string, options: SqlSemanticBuildOptions = {}): SqlLocalSchemaOverlay {
  if (!sql.trim() || sql.length > MAX_LOCAL_SCHEMA_SQL_LENGTH) return { tables: [] };
  if (options.databaseType && options.databaseType !== "postgres" && options.databaseType !== "mysql" && options.databaseType !== "sqlite") return { tables: [] };
  const dialectId = resolveSqlDialectId(options);
  const adapter = sqlSemanticDialectFor(options);
  const tokens = tokenizeSqlSemantic(sql, dialectId, {
    mysqlBackslashEscape: dialectId === "mysql" || dialectId === "doris",
    mysqlDashCommentRequiresWhitespace: dialectId === "mysql" || dialectId === "doris",
  });
  const statements = splitStatements(tokens);
  const tables = new Map<string, SqlLocalSchemaTable>();

  for (const statement of statements) {
    const create = createTableNameIndex(statement);
    if (create >= 0) {
      const name = readQualifiedName(statement, skipIfNotExists(statement, create), adapter);
      if (!name) continue;
      const table = tableFromName(name, statement, adapter);
      const key = tableKey(table, adapter);
      if (tables.has(key)) continue;
      const asIndex = statement.findIndex((token, index) => index >= name.nextIndex && token.normalized === "as" && token.depth === 0);
      const openIndex = statement.findIndex((token, index) => index >= name.nextIndex && token.text === "(" && token.depth === 0);
      if (asIndex >= 0 && (openIndex < 0 || asIndex < openIndex)) {
        table.columns = queryOutputColumns(statement, asIndex + 1, table.name, table.schema, adapter);
      } else if (openIndex >= 0) {
        table.columns = columnDefinitions(statement, openIndex, table.name, table.schema, adapter);
      }
      tables.set(key, table);
      continue;
    }
    applyAlterTable(statement, tables, adapter);
  }
  return { tables: [...tables.values()] };
}

function splitStatements(tokens: readonly SqlSemanticToken[]): SqlSemanticToken[][] {
  const statements: SqlSemanticToken[][] = [];
  let current: SqlSemanticToken[] = [];
  for (const token of tokens) {
    if (token.kind === "comment") continue;
    if (token.kind === "punctuation" && token.text === ";" && token.depth === 0) {
      if (current.length > 0) statements.push(current);
      current = [];
    } else current.push(token);
  }
  if (current.length > 0) statements.push(current);
  return statements;
}

function createTableNameIndex(tokens: readonly SqlSemanticToken[]): number {
  if (tokens[0]?.normalized !== "create") return -1;
  let index = 1;
  while (CREATE_TABLE_MODIFIERS.has(tokens[index]?.normalized ?? "")) index += 1;
  return tokens[index]?.normalized === "table" ? index + 1 : -1;
}

function skipIfNotExists(tokens: readonly SqlSemanticToken[], index: number): number {
  return tokens[index]?.normalized === "if" && tokens[index + 1]?.normalized === "not" && tokens[index + 2]?.normalized === "exists" ? index + 3 : index;
}

function readQualifiedName(tokens: readonly SqlSemanticToken[], start: number, adapter: ReturnType<typeof sqlSemanticDialectFor>): QualifiedLocalName | null {
  const parts: QualifiedLocalName["parts"] = [];
  let index = start;
  while (tokenIsIdentifier(tokens[index])) {
    const token = tokens[index];
    const quoted = token.kind === "quoted_identifier";
    parts.push({ name: adapter.normalizeIdentifier(unquoteSqlSemanticIdentifier(token), quoted), raw: token.text, quoted, span: token.span });
    if (tokens[index + 1]?.text !== ".") {
      index += 1;
      break;
    }
    index += 2;
    if (!tokenIsIdentifier(tokens[index])) return null;
  }
  return parts.length > 0 ? { parts, nextIndex: index } : null;
}

function tableFromName(name: QualifiedLocalName, statement: readonly SqlSemanticToken[], adapter: ReturnType<typeof sqlSemanticDialectFor>): SqlLocalSchemaTable {
  const last = name.parts[name.parts.length - 1];
  const previous = name.parts[name.parts.length - 2];
  const catalog = name.parts[name.parts.length - 3];
  const first = statement[0];
  const lastToken = statement[statement.length - 1] ?? first;
  return {
    name: last.name,
    schema: previous?.name,
    catalog: catalog?.name,
    database: adapter.id === "mysql" && previous ? previous.name : undefined,
    type: "table",
    applyName: name.parts.map((part) => part.raw).join("."),
    nameQuoted: last.quoted,
    schemaQuoted: previous?.quoted,
    columns: [],
    statementSpan: { start: first?.span.start ?? last.span.start, end: lastToken?.span.end ?? last.span.end },
  };
}

function tableKey(table: SqlLocalSchemaTable, adapter: ReturnType<typeof sqlSemanticDialectFor>): string {
  const normalize = (value: string | undefined, quoted: boolean | undefined) => (value === undefined ? "" : quoted ? value : adapter.id === "postgres" ? value.toLowerCase() : value.toLowerCase());
  return JSON.stringify([normalize(table.catalog, false), normalize(table.database ?? table.schema, table.schemaQuoted), normalize(table.name, table.nameQuoted)]);
}

function columnDefinitions(statement: readonly SqlSemanticToken[], openIndex: number, table: string, schema: string | undefined, adapter: ReturnType<typeof sqlSemanticDialectFor>): SqlLocalSchemaColumn[] {
  const open = statement[openIndex];
  const closeIndex = statement.findIndex((token, index) => index > openIndex && token.text === ")" && token.depth === open.depth);
  const endIndex = closeIndex >= 0 ? closeIndex : statement.length;
  const groups = splitByDepthComma(statement.slice(openIndex + 1, endIndex), open.depth + 1);
  const columns: SqlLocalSchemaColumn[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    const column = columnDefinition(group, table, schema, adapter);
    if (!column) continue;
    const key = column.nameQuoted ? column.name : column.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    columns.push(column);
  }
  return columns;
}

function columnDefinition(tokens: readonly SqlSemanticToken[], table: string, schema: string | undefined, adapter: ReturnType<typeof sqlSemanticDialectFor>): SqlLocalSchemaColumn | null {
  const first = tokens[0];
  if (!tokenIsIdentifier(first) || (first.kind === "word" && TABLE_CONSTRAINT_START.has(first.normalized))) return null;
  const quoted = first.kind === "quoted_identifier";
  const name = adapter.normalizeIdentifier(unquoteSqlSemanticIdentifier(first), quoted);
  if (!name) return null;
  const last = tokens[tokens.length - 1] ?? first;
  const dataTypeEnd = tokens.findIndex((token, index) => index > 0 && token.kind === "word" && COLUMN_CONSTRAINT_START.has(token.normalized));
  const dataTypeTokens = tokens.slice(1, dataTypeEnd > 0 ? dataTypeEnd : tokens.length);
  const dataType =
    dataTypeTokens.length > 0
      ? dataTypeTokens
          .map((token) => token.text)
          .join(" ")
          .replace(/\s+([),])/g, "$1")
          .replace(/\(\s+/g, "(")
          .trim()
      : undefined;
  const normalized = tokens.map((token) => token.normalized);
  const primary = normalized.includes("primary") && normalized.includes("key");
  const notNull = normalized.some((value, index) => value === "not" && normalized[index + 1] === "null");
  return {
    name,
    table,
    schema,
    dataType: dataType || undefined,
    isNullable: primary || notNull ? false : undefined,
    nameQuoted: quoted,
    span: { start: first.span.start, end: last.span.end },
  };
}

function splitByDepthComma(tokens: readonly SqlSemanticToken[], depth: number): SqlSemanticToken[][] {
  const groups: SqlSemanticToken[][] = [];
  let current: SqlSemanticToken[] = [];
  for (const token of tokens) {
    if (token.text === "," && token.depth === depth) {
      if (current.length > 0) groups.push(current);
      current = [];
    } else current.push(token);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function queryOutputColumns(statement: readonly SqlSemanticToken[], queryStart: number, table: string, schema: string | undefined, adapter: ReturnType<typeof sqlSemanticDialectFor>): SqlLocalSchemaColumn[] {
  const selectIndex = statement.findIndex((token, index) => index >= queryStart && token.normalized === "select" && token.depth === 0);
  if (selectIndex < 0) return [];
  const fromIndex = statement.findIndex((token, index) => index > selectIndex && token.normalized === "from" && token.depth === 0);
  const end = fromIndex >= 0 ? fromIndex : statement.length;
  const groups = splitByDepthComma(statement.slice(selectIndex + 1, end), 0);
  const columns: SqlLocalSchemaColumn[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    const identifiers = group.filter(tokenIsIdentifier);
    const aliasIndex = group.findIndex((token) => token.normalized === "as");
    const candidate = aliasIndex >= 0 ? group[aliasIndex + 1] : identifiers[identifiers.length - 1];
    if (!tokenIsIdentifier(candidate) || candidate.text === "*") continue;
    if (aliasIndex < 0 && /^(?:select|from|where|group|order|having|limit|union|intersect|except)$/.test(candidate.normalized)) continue;
    const quoted = candidate.kind === "quoted_identifier";
    const name = adapter.normalizeIdentifier(unquoteSqlSemanticIdentifier(candidate), quoted);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    columns.push({ name, table, schema, nameQuoted: quoted, span: candidate.span });
  }
  return columns;
}

function applyAlterTable(statement: readonly SqlSemanticToken[], tables: Map<string, SqlLocalSchemaTable>, adapter: ReturnType<typeof sqlSemanticDialectFor>): void {
  if (statement[0]?.normalized !== "alter" || statement[1]?.normalized !== "table") return;
  const name = readQualifiedName(statement, 2, adapter);
  if (!name) return;
  const target = tableFromName(name, statement, adapter);
  const table = tables.get(tableKey(target, adapter));
  if (!table) return;
  const addIndex = statement.findIndex((token, index) => index >= name.nextIndex && token.normalized === "add");
  if (addIndex < 0) return;
  let start = addIndex + 1;
  if (statement[start]?.normalized === "column") start += 1;
  if (statement[start]?.normalized === "if" && statement[start + 1]?.normalized === "not" && statement[start + 2]?.normalized === "exists") start += 3;
  const groups = splitByDepthComma(statement.slice(start), 0);
  const existing = new Set(table.columns.map((column) => (column.nameQuoted ? column.name : column.name.toLowerCase())));
  for (const group of groups) {
    const column = columnDefinition(group, table.name, table.schema, adapter);
    if (!column) continue;
    const key = column.nameQuoted ? column.name : column.name.toLowerCase();
    if (existing.has(key)) continue;
    existing.add(key);
    table.columns.push(column);
  }
}
