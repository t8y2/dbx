import type { ColumnInfo, IndexInfo } from "@/types/database";
import type { SqlCompletionTable } from "@/lib/sql/sqlCompletion";
import { isSqlKeyword } from "@/lib/sql/sqlNavigation";

export interface HoverTableScope {
  catalog?: string;
  database: string;
  schema?: string;
}

function normalizedScopePart(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

export function scopeHoverTables(tables: SqlCompletionTable[], scope: HoverTableScope): SqlCompletionTable[] {
  return tables.map((table) => ({
    ...table,
    catalog: table.catalog ?? scope.catalog,
    database: table.database ?? scope.database,
    schema: table.schema ?? scope.schema,
  }));
}

export function hoverTableMatchesScope(table: SqlCompletionTable, scope: HoverTableScope): boolean {
  if (normalizedScopePart(table.database) !== normalizedScopePart(scope.database)) return false;
  if (normalizedScopePart(scope.catalog) && normalizedScopePart(table.catalog) !== normalizedScopePart(scope.catalog)) return false;
  if (normalizedScopePart(scope.schema) && normalizedScopePart(table.schema) !== normalizedScopePart(scope.schema)) return false;
  return true;
}

/**
 * Format a column's data type for display in the hover DDL.
 *
 * - If the backend already reports a parameterized type (e.g. `varchar(255)`,
 *   `datetime2(7)`), trust it as-is.
 * - For character types with `character_maximum_length`, append the length.
 *   SQL Server maps `-1` to `(max)`.
 * - For numeric types with `numeric_precision` / `numeric_scale`, append the
 *   precision/scale.
 * - Otherwise return the raw `data_type` from the backend unchanged.
 */
function formatColumnType(c: ColumnInfo): string {
  const dataType = c.data_type.trim();
  // Backend already reports a parameterized type — trust it.
  if (/\([^()]*\)$/.test(dataType)) return dataType;
  // SQL Server character_maximum_length of -1 means (max)
  if (c.character_maximum_length != null && c.numeric_scale == null) {
    if (c.character_maximum_length === -1) return `${dataType}(max)`;
    return `${dataType}(${c.character_maximum_length})`;
  }
  if (c.numeric_precision != null && c.numeric_scale != null) {
    if (c.numeric_scale === 0) return `${dataType}(${c.numeric_precision})`;
    return `${dataType}(${c.numeric_precision},${c.numeric_scale})`;
  }
  return dataType;
}

/**
 * Render a column default value in SQL form.
 *
 * String literals are kept as-is, numeric values and SQL keywords are
 * unquoted, and other bare values are wrapped in single quotes.
 * Only called when the backend `column_default` is not null.
 */
function formatDefaultValue(value: string): string {
  // Already quoted string literal — keep as-is.
  if (/^'/.test(value)) return value;
  // Numeric values — no quotes.
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  // Expression default (wrapped in parentheses) — keep as-is.
  if (/^\(/.test(value)) return value;
  // SQL keywords (NULL, TRUE, FALSE, etc.) — no quotes.
  if (isSqlKeyword(value)) return value;
  // Well-known SQL functions commonly used as defaults — no quotes.
  if (/^(current_timestamp|current_date|current_time|localtimestamp|localtime|now|getdate|random|gen_random_uuid|uuid)\s*(?:\(.*\))?$/i.test(value)) return value;
  // Other bare string values — wrap in quotes.
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Strip CHARACTER SET / COLLATE clauses from a raw backend DDL for hover display.
 *
 * MySQL `SHOW CREATE TABLE` appends `CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
 * to each VARCHAR/CHAR column and `DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
 * to table options. These are redundant in a quick-look tooltip and add visual noise.
 *
 * Only affects the hover display — never modifies the source DDL on the backend.
 */
export function sanitizeHoverDdl(ddl: string): string {
  // Table-level patterns run before column-level to consume DEFAULT first,
  // preventing MariaDB `DEFAULT CHARACTER SET utf8` from leaving an orphan DEFAULT.
  return (
    ddl
      // Table-level: `DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`
      .replace(/\s+DEFAULT\s+CHARSET\s*=\s*\w+(?:\s+COLLATE\s*=\s*\w+)?/gi, "")
      // Table-level: `DEFAULT CHARACTER SET utf8 COLLATE utf8_general_ci` (MariaDB)
      .replace(/\s+DEFAULT\s+CHARACTER\s+SET\s+\w+(?:\s+COLLATE\s+\w+)?/gi, "")
      // Standalone `CHARSET=utf8mb4`, `CHARACTER SET utf8mb4`, or
      // `CHARACTER SET utf8mb4 COLLATE utf8_general_ci` (table- or column-level)
      .replace(/\s+CHARACTER\s+SET\s+\w+(?:\s+COLLATE\s+\w+)?/gi, "")
      .replace(/\s+CHARSET\s*=\s*\w+/gi, "")
      // Standalone `COLLATE=utf8mb4_general_ci` or `COLLATE utf8mb4_general_ci`
      .replace(/\s+COLLATE(?:\s*=\s*|\s+)\w+/gi, "")
      .trim()
  );
}

/**
 * Display fields of a single column line, prior to vertical alignment.
 */
interface ColumnFieldParts {
  name: string;
  type: string;
  nullable: string; // "not null" or "null"
  defaultClause: string; // "default <value>" or empty
  extra: string; // extra attributes (auto_increment, etc.) or empty
  commentClause: string; // "comment '...'" or empty
}

/**
 * Render column rows with each field (name, type, extra, default, nullable,
 * comment) vertically aligned across all column lines. Shared by both the
 * metadata-based builder and the raw-DDL reformatter so both hover paths
 * produce the same visual layout.
 */
function alignColumnRows(rows: ColumnFieldParts[]): string[] {
  const maxNameWidth = Math.max(...rows.map((r) => r.name.length));
  const maxTypeWidth = Math.max(...rows.map((r) => r.type.length), 4);
  const hasExtra = rows.some((r) => r.extra);
  const hasDefault = rows.some((r) => r.defaultClause);
  const hasComment = rows.some((r) => r.commentClause);
  const maxNullableWidth = Math.max(...rows.map((r) => r.nullable.length));
  const maxExtraWidth = Math.max(...rows.map((r) => r.extra.length));
  const maxDefaultWidth = Math.max(...rows.map((r) => r.defaultClause.length));

  // Field order: name → type → [extra] → [defaultClause] → nullable → [commentClause]
  return rows.map((r) => {
    const parts: string[] = [r.name.padEnd(maxNameWidth), " ", r.type.padEnd(maxTypeWidth)];
    if (hasExtra) parts.push(" ", r.extra.padEnd(maxExtraWidth));
    if (hasDefault) parts.push(" ", r.defaultClause.padEnd(maxDefaultWidth));
    parts.push(" ", r.nullable.padEnd(maxNullableWidth));
    if (hasComment) parts.push(" ", r.commentClause);
    return parts.join("").trimEnd();
  });
}

/**
 * Quote a SQL identifier by wrapping it in double quotes with proper escaping.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quote each segment of a qualified name (e.g. `db.schema.table`).
 */
export function quoteQualifiedName(qualifiedName: string): string {
  const segments = qualifiedName.split(".");
  return segments.map((seg) => (seg.startsWith('"') ? seg : quoteIdentifier(seg))).join(".");
}

/**
 * Build a human-readable `CREATE TABLE` DDL for the hover tooltip.
 *
 * **Primary path**: the backend's `getTableDdl` API should be preferred when
 * available — it returns database-specific DDL (e.g. `SHOW CREATE TABLE`,
 * Postgres `pg_ddl`, SQL Server `build_sqlserver_ddl`). This function is the
 * **fallback** used when the backend DDL path is unavailable.
 *
 * The output is formatted for readability in the hover tooltip, not for
 * execution. Columns are listed with each field (name, type, nullable,
 * default, extra, comment) vertically aligned across all column lines,
 * followed by a table-level PRIMARY KEY clause and non-primary index DDL.
 */
export function buildHoverTableSql(qualifiedName: string, columns: ColumnInfo[], indexes: IndexInfo[], tableComment?: string): string {
  // Resolve primary key columns from the index (handles composite keys), or
  // fall back to column-level primary key flags when the index is absent.
  const primaryKeyIndex = indexes.find((idx) => idx.is_primary);
  let pkColumns: string[];
  if (primaryKeyIndex?.columns?.length) {
    pkColumns = primaryKeyIndex.columns;
  } else {
    pkColumns = columns.filter((c) => c.is_primary_key).map((c) => c.name);
  }

  // Pre-compute each column's display fields so we can determine column widths
  // for vertical alignment.
  const rows: ColumnFieldParts[] = columns.map((c) => {
    const type = formatColumnType(c);
    const nullable = c.is_nullable ? "null" : "not null";
    const defaultClause = c.column_default != null ? `default ${formatDefaultValue(c.column_default)}` : "";
    const extra = c.extra ?? "";
    const commentClause = c.comment ? `comment '${c.comment.replace(/'/g, "''")}'` : "";
    return {
      name: `    ${quoteIdentifier(c.name)}`,
      type,
      nullable,
      defaultClause,
      extra,
      commentClause,
    };
  });

  // Build each column line with vertical alignment.
  const columnDefs: string[] = alignColumnRows(rows);

  // Append the PRIMARY KEY constraint if there are PK columns.
  if (pkColumns.length > 0) {
    columnDefs.push(`  primary key (${pkColumns.map(quoteIdentifier).join(", ")})`);
  }

  const closeSuffix = tableComment?.trim() ? ` comment '${tableComment.replace(/'/g, "''")}';` : ";";

  const ddl = `create table ${qualifiedName} (\n${columnDefs.join(",\n")}\n)${closeSuffix}`;

  // Append non-primary index DDL.
  const nonPrimaryIndexes = indexes.filter((idx) => !idx.is_primary);
  if (nonPrimaryIndexes.length === 0) return ddl;

  const indexLines: string[] = [""];
  for (const idx of nonPrimaryIndexes) {
    const uniquePrefix = idx.is_unique ? "unique " : "";
    indexLines.push(`create ${uniquePrefix}index ${quoteIdentifier(idx.name)}`);
    indexLines.push(`  on ${qualifiedName} (${idx.columns.map((c) => quoteIdentifier(c)).join(", ")});`);
  }

  return ddl + "\n" + indexLines.join("\n");
}

// ---------------------------------------------------------------------------
// Raw backend DDL parsing & realignment (primary hover path)
// ---------------------------------------------------------------------------

/** Scan past a delimited region (string literal or quoted identifier). */
function scanDelimited(text: string, start: number, close: string): number {
  let i = start + 1;
  const backslashEscapes = close === "'";
  while (i < text.length) {
    const ch = text[i];
    if (backslashEscapes && ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === close) {
      // Doubled delimiter is an escape ('' "" `` ]])
      if (text[i + 1] === close) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return text.length;
}

/** Scan past a balanced parenthesized group, respecting quotes. */
function scanGroup(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = scanDelimited(text, i, ch);
      continue;
    }
    if (ch === "[") {
      i = scanDelimited(text, i, "]");
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return text.length;
}

/** Split text on a separator at parenthesis depth 0, outside quotes. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = scanDelimited(text, i, ch);
      continue;
    }
    if (ch === "[") {
      i = scanDelimited(text, i, "]");
      continue;
    }
    if (ch === "(") {
      i = scanGroup(text, i);
      continue;
    }
    if (ch === separator) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(text.slice(start));
  return parts;
}

interface DdlToken {
  text: string;
  start: number;
  end: number;
}

/**
 * Tokenize a DDL fragment into words, quoted identifiers, string literals and
 * whole parenthesized groups (each group is a single token).
 */
function tokenizeDdl(text: string): DdlToken[] {
  const tokens: DdlToken[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    let end: number;
    if (ch === "'" || ch === '"' || ch === "`") end = scanDelimited(text, i, ch);
    else if (ch === "[") end = scanDelimited(text, i, "]");
    else if (ch === "(") end = scanGroup(text, i);
    else {
      const m = /^[^\s'"`()[\],]+/.exec(text.slice(i));
      end = i + (m ? m[0].length : 1);
    }
    tokens.push({ text: text.slice(i, end), start: i, end });
    i = end;
  }
  return tokens;
}

/** Remove backtick / double-quote / bracket quoting from an identifier. */
function unquoteIdentifier(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("`") && t.endsWith("`")) return t.slice(1, -1).replace(/``/g, "`");
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/""/g, '"');
  if (t.startsWith("[") && t.endsWith("]")) return t.slice(1, -1).replace(/]]/g, "]");
  return t;
}

/** Remove single-quote wrapping and unescape a SQL string literal. */
function unquoteSqlString(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'").replace(/\\'/g, "'");
  }
  return t;
}

/** Quote a parsed key column unless it is an expression (functional index). */
function quoteKeyColumn(col: string): string {
  return /^[\w$#]+$/.test(col) ? quoteIdentifier(col) : col;
}

interface ParsedDdlColumn {
  name: string;
  type: string;
  nullable: string;
  defaultClause: string;
  extra: string;
  comment: string;
}

interface ParsedIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

interface ParsedCreateTable {
  qualifiedName: string;
  columns: ParsedDdlColumn[];
  pkColumns: string[];
  constraintLines: string[];
  indexes: ParsedIndex[];
  tableComment?: string;
}

// Keywords that terminate the data type and introduce a column clause.
const COLUMN_CLAUSE_BOUNDARIES = new Set(["not", "null", "default", "auto_increment", "comment", "generated", "primary", "unique", "references", "check", "on", "constraint", "identity", "stored", "virtual", "invisible", "visible", "collate"]);

// A body line starting with one of these keywords is a table-level constraint.
const CONSTRAINT_LINE_KEYWORDS = new Set(["primary", "unique", "key", "index", "constraint", "foreign", "check", "fulltext", "spatial", "exclude", "period", "like"]);

/** Parse an index/PK column list, dropping prefix lengths and ASC/DESC. */
function parseKeyColumns(group: string): string[] {
  return splitTopLevel(group, ",")
    .map((part) => {
      let p = part.trim();
      p = p.replace(/\s+(asc|desc)$/i, "");
      p = p.replace(/\(\d+\)$/, ""); // MySQL prefix length: `email`(20)
      return unquoteIdentifier(p.trim());
    })
    .filter(Boolean);
}

/** Parse one column definition line of a CREATE TABLE body. */
function parseColumnLine(line: string): { column: ParsedDdlColumn; inlinePk: boolean } | null {
  const tokens = tokenizeDdl(line);
  if (tokens.length < 2) return null;
  const name = unquoteIdentifier(tokens[0].text);
  const tokenAt = (i: number) => tokens[i]?.text.toLowerCase();

  // Everything before the first clause keyword is the data type
  // (e.g. `int(11) unsigned`, `character varying(255)`, `timestamp with time zone`).
  let boundary = tokens.length;
  for (let i = 1; i < tokens.length; i++) {
    if (COLUMN_CLAUSE_BOUNDARIES.has(tokenAt(i)!)) {
      boundary = i;
      break;
    }
  }
  if (boundary <= 1) return null;
  const type = line.slice(tokens[1].start, tokens[boundary - 1].end);

  let nullable = "null";
  let defaultClause = "";
  let comment = "";
  let inlinePk = false;
  const extras: string[] = [];

  let k = boundary;
  while (k < tokens.length) {
    const t = tokenAt(k)!;
    if (t === "not" && tokenAt(k + 1) === "null") {
      nullable = "not null";
      k += 2;
      continue;
    }
    if (t === "null") {
      nullable = "null";
      k += 1;
      continue;
    }
    if (t === "default" && k + 1 < tokens.length) {
      // The first value token is always part of the expression (handles
      // DEFAULT NULL); subsequent tokens run until the next clause keyword.
      let end = k + 2;
      while (end < tokens.length && !COLUMN_CLAUSE_BOUNDARIES.has(tokenAt(end)!)) end++;
      defaultClause = `default ${line.slice(tokens[k + 1].start, tokens[end - 1].end)}`;
      k = end;
      continue;
    }
    if (t === "comment" && k + 1 < tokens.length) {
      comment = unquoteSqlString(tokens[k + 1].text);
      k += 2;
      continue;
    }
    if (t === "primary" && tokenAt(k + 1) === "key") {
      inlinePk = true;
      k += 2;
      continue;
    }
    if (t === "unique") {
      extras.push("unique");
      k += tokenAt(k + 1) === "key" ? 2 : 1;
      continue;
    }
    // Unrecognized clause (AUTO_INCREMENT, ON UPDATE ..., GENERATED ... AS (...),
    // IDENTITY(1,1), REFERENCES ..., ...): keep the keyword and any following
    // non-keyword tokens verbatim as extra attributes.
    let end = k + 1;
    while (end < tokens.length && !COLUMN_CLAUSE_BOUNDARIES.has(tokenAt(end)!)) end++;
    extras.push(line.slice(tokens[k].start, tokens[end - 1].end));
    k = end;
  }

  return {
    column: { name, type, nullable, defaultClause, extra: extras.join(" "), comment },
    inlinePk,
  };
}

/** Parse one table-level constraint line of a CREATE TABLE body. */
function parseConstraintLine(line: string, parsed: ParsedCreateTable): void {
  let rest = line.trim();
  const named = /^constraint\s+(?:`(?:``|[^`])*`|"(?:""|[^"])*"|\[(?:]]|[^\]])*]|\S+)\s+/i.exec(rest);
  const namedPrefixLength = named ? named[0].length : 0;
  rest = rest.slice(namedPrefixLength);

  const tokens = tokenizeDdl(rest);
  const tokenAt = (i: number) => tokens[i]?.text.toLowerCase();
  const groupIdx = tokens.findIndex((tok) => tok.text.startsWith("("));
  const groupColumns = groupIdx >= 0 ? parseKeyColumns(tokens[groupIdx].text.slice(1, -1)) : [];

  if (tokenAt(0) === "primary" && tokenAt(1) === "key" && groupColumns.length > 0) {
    parsed.pkColumns.push(...groupColumns);
    return;
  }
  if (tokenAt(0) === "unique" && (tokenAt(1) === "key" || tokenAt(1) === "index") && groupIdx >= 2 && groupColumns.length > 0) {
    parsed.indexes.push({ name: unquoteIdentifier(tokens[groupIdx - 1].text), columns: groupColumns, unique: true });
    return;
  }
  if ((tokenAt(0) === "key" || tokenAt(0) === "index") && groupIdx >= 2 && groupColumns.length > 0) {
    parsed.indexes.push({ name: unquoteIdentifier(tokens[groupIdx - 1].text), columns: groupColumns, unique: false });
    return;
  }
  // FOREIGN KEY / CHECK / EXCLUDE / unnamed UNIQUE / FULLTEXT ... — preserve verbatim.
  parsed.constraintLines.push(line.trim());
}

/** Parse a single CREATE TABLE statement. Returns null when unparseable. */
function parseCreateTableStatement(statement: string): ParsedCreateTable | null {
  const header = /^\s*create\s+(?:or\s+replace\s+)?(?:global\s+|local\s+|temporary\s+|temp\s+|unlogged\s+|external\s+)*table\s+(?:if\s+not\s+exists\s+)?/i.exec(statement);
  if (!header) return null;
  const rest = statement.slice(header[0].length);
  const tokens = tokenizeDdl(rest);
  const bodyIdx = tokens.findIndex((tok) => tok.text.startsWith("("));
  if (bodyIdx <= 0) return null;

  const rawName = rest.slice(tokens[0].start, tokens[bodyIdx - 1].end);
  const qualifiedName = splitTopLevel(rawName, ".")
    .map((seg) => quoteIdentifier(unquoteIdentifier(seg.trim())))
    .join(".");

  const parsed: ParsedCreateTable = {
    qualifiedName,
    columns: [],
    pkColumns: [],
    constraintLines: [],
    indexes: [],
  };

  const body = tokens[bodyIdx].text.slice(1, -1);
  for (const rawLine of splitTopLevel(body, ",")) {
    const line = rawLine.trim();
    if (!line) continue;
    const firstWord = /^[A-Za-z_]+/.exec(line)?.[0].toLowerCase();
    if (firstWord && CONSTRAINT_LINE_KEYWORDS.has(firstWord)) {
      parseConstraintLine(line, parsed);
      continue;
    }
    const col = parseColumnLine(line);
    // An unparseable column line means the whole reconstruction is unsafe —
    // bail out so the caller falls back to the sanitized raw DDL.
    if (!col) return null;
    parsed.columns.push(col.column);
    if (col.inlinePk) parsed.pkColumns.push(col.column.name);
  }

  // Table options: keep only the COMMENT, drop ENGINE / AUTO_INCREMENT / ... noise.
  const optionsText = rest.slice(tokens[bodyIdx].end);
  const cm = /comment\s*=?\s*('(?:\\'|''|[^'])*')/i.exec(optionsText);
  if (cm) parsed.tableComment = unquoteSqlString(cm[1]);

  return parsed;
}

/** Parse a standalone CREATE [UNIQUE] INDEX statement. */
function parseCreateIndexStatement(statement: string): ParsedIndex | null {
  const header = /^\s*create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?/i.exec(statement);
  if (!header) return null;
  const rest = statement.slice(header[0].length);
  const tokens = tokenizeDdl(rest);
  if (tokens.length < 3 || tokens[1].text.toLowerCase() !== "on") return null;
  const groupIdx = tokens.findIndex((tok) => tok.text.startsWith("("));
  if (groupIdx < 2) return null;
  const columns = parseKeyColumns(tokens[groupIdx].text.slice(1, -1));
  if (columns.length === 0) return null;
  return { name: unquoteIdentifier(tokens[0].text), columns, unique: !!header[1] };
}

/** Render a parsed CREATE TABLE with buildHoverTableSql's aligned layout. */
function renderParsedCreateTable(parsed: ParsedCreateTable, qualifiedNameOverride: string | undefined, passthroughStatements: string[]): string {
  const displayName = qualifiedNameOverride ?? parsed.qualifiedName;
  const rows: ColumnFieldParts[] = parsed.columns.map((c) => ({
    name: `    ${quoteIdentifier(c.name)}`,
    type: c.type,
    nullable: c.nullable,
    defaultClause: c.defaultClause,
    extra: c.extra,
    commentClause: c.comment ? `comment '${c.comment.replace(/'/g, "''")}'` : "",
  }));

  const columnDefs = alignColumnRows(rows);
  if (parsed.pkColumns.length > 0) {
    columnDefs.push(`  primary key (${parsed.pkColumns.map(quoteKeyColumn).join(", ")})`);
  }
  for (const constraintLine of parsed.constraintLines) {
    columnDefs.push(`  ${constraintLine}`);
  }

  const closeSuffix = parsed.tableComment?.trim() ? ` comment '${parsed.tableComment.replace(/'/g, "''")}';` : ";";
  let ddl = `create table ${displayName} (\n${columnDefs.join(",\n")}\n)${closeSuffix}`;

  if (parsed.indexes.length > 0) {
    const indexLines: string[] = [""];
    for (const idx of parsed.indexes) {
      const uniquePrefix = idx.unique ? "unique " : "";
      indexLines.push(`create ${uniquePrefix}index ${quoteIdentifier(idx.name)}`);
      indexLines.push(`  on ${displayName} (${idx.columns.map(quoteKeyColumn).join(", ")});`);
    }
    ddl += "\n" + indexLines.join("\n");
  }

  if (passthroughStatements.length > 0) {
    ddl += "\n\n" + passthroughStatements.join("\n");
  }
  return ddl;
}

/**
 * Reformat a raw backend DDL (`getTableDdl`) for the hover tooltip.
 *
 * This is the **primary** hover path: the backend DDL is authoritative
 * (SHOW CREATE TABLE, pg_ddl, build_sqlserver_ddl, ...). The DDL is first
 * stripped of charset/COLLATE noise, then parsed into structured fields and
 * rebuilt with the same vertical alignment as {@link buildHoverTableSql}
 * (name, type, extra, default, nullable, comment). Companion statements are
 * merged in: `COMMENT ON TABLE/COLUMN` become inline comments and
 * `CREATE INDEX` statements are re-emitted after the table.
 *
 * When the DDL cannot be parsed confidently, the sanitized raw DDL is
 * returned unchanged so no information is ever lost.
 */
export function reformatHoverDdl(rawDdl: string, qualifiedName?: string): string {
  const sanitized = sanitizeHoverDdl(rawDdl);
  const statements = splitTopLevel(sanitized, ";")
    .map((s) => s.trim())
    .filter(Boolean);
  // Companion statements can carry database-specific semantics that this
  // lightweight formatter cannot reproduce losslessly (for example Postgres
  // USING / INCLUDE / WHERE index clauses). Keep the sanitized backend DDL.
  if (statements.length !== 1) return sanitized;
  const createIdx = statements.findIndex((s) => /^\s*create\s+(?:or\s+replace\s+)?(?:global\s+|local\s+|temporary\s+|temp\s+|unlogged\s+|external\s+)*table\b/i.test(s));
  if (createIdx === -1) return sanitized;

  const parsed = parseCreateTableStatement(statements[createIdx]);
  if (!parsed || parsed.columns.length === 0) return sanitized;

  // Table suffixes such as PARTITION BY, DISTRIBUTED BY, ENGINE, TABLESPACE,
  // and storage options are backend-specific. Rebuilding them partially would
  // silently remove structure, so only reformat a CREATE TABLE whose suffix is
  // empty or consists solely of a table COMMENT that the parser preserves.
  const createStatement = statements[createIdx];
  const header = /^\s*create\s+(?:or\s+replace\s+)?(?:global\s+|local\s+|temporary\s+|temp\s+|unlogged\s+|external\s+)*table\s+(?:if\s+not\s+exists\s+)?/i.exec(createStatement);
  const rest = header ? createStatement.slice(header[0].length) : "";
  const bodyToken = tokenizeDdl(rest).find((token) => token.text.startsWith("("));
  const suffix = bodyToken ? rest.slice(bodyToken.end).trim() : "";
  const suffixWithoutComment = suffix.replace(/^comment\s*=?\s*('(?:\\'|''|[^'])*')\s*$/i, "").trim();
  if (suffixWithoutComment) return sanitized;

  const passthrough: string[] = [];
  for (let i = 0; i < statements.length; i++) {
    if (i === createIdx) continue;
    const statement = statements[i];

    const tableCommentMatch = /^comment\s+on\s+table\s+.+?\s+is\s+('(?:\\'|''|[^'])*')\s*$/is.exec(statement);
    if (tableCommentMatch) {
      parsed.tableComment ??= unquoteSqlString(tableCommentMatch[1]);
      continue;
    }

    const columnCommentMatch = /^comment\s+on\s+column\s+(\S+)\s+is\s+('(?:\\'|''|[^'])*')\s*$/is.exec(statement);
    if (columnCommentMatch) {
      const segments = splitTopLevel(columnCommentMatch[1], ".");
      const columnName = unquoteIdentifier(segments[segments.length - 1] ?? "");
      const column = parsed.columns.find((c) => c.name.toLowerCase() === columnName.toLowerCase());
      if (column) {
        if (!column.comment) column.comment = unquoteSqlString(columnCommentMatch[2]);
        continue;
      }
    }

    const index = parseCreateIndexStatement(statement);
    if (index) {
      parsed.indexes.push(index);
      continue;
    }

    passthrough.push(`${statement};`);
  }

  return renderParsedCreateTable(parsed, qualifiedName, passthrough);
}
