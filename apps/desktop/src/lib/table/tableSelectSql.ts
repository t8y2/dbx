import type { DatabaseType } from "@/types/database.ts";
import { isSchemaAware, usesDatabaseObjectTreeMode } from "@/lib/database/databaseCapabilities.ts";
import { jdbcDriverProfileUsesSchemaQualification } from "@/lib/database/jdbcDialect";
import * as api from "@/lib/backend/api.ts";
import { parseSqlServerLinkedSchema, sqlServerLinkedTableName } from "@/lib/database/sqlServerLinkedServers.ts";
import { isExplicitlyQuotedSqlIdentifier, quoteGaussDbJdbcIdentifier } from "@/lib/sql/sqlIdentifier.ts";
import { sqlSemanticDialectFor } from "@/lib/sql/semantic/dialect";
import { sqlSemanticTableNameSpans } from "@/lib/sql/semantic/model";
import { tokenIsIdentifier, tokenizeSqlSemantic, unquoteSqlSemanticIdentifier } from "@/lib/sql/semantic/tokens";
import type { SqlSemanticToken } from "@/lib/sql/semantic/types";

export interface BuildTableSelectSqlOptions {
  databaseType?: DatabaseType;
  driverProfile?: string;
  identifierQuote?: string;
  schema?: string;
  tableName: string;
  tableType?: string;
  primaryKeys?: string[];
  columns?: string[];
  columnTypes?: string[];
  largeValuePreviewSize?: number;
  fallbackOrderColumns?: string[];
  orderBy?: string;
  limit?: number;
  offset?: number;
  useDriverRowOffset?: boolean;
  whereInput?: string;
  includeRowId?: boolean;
  catalog?: string;
  database?: string;
  /** Include the active database when this dialect supports `database.table` references. */
  includeDatabaseName?: boolean;
}

const DATABASE_QUALIFIED_TABLE_TYPES = new Set<DatabaseType>(["mysql", "clickhouse", "doris", "starrocks", "goldendb"]);

function sqlStatementSpans(sql: string, dialectId: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  const appendSpan = (end: number) => {
    let trimmedStart = start;
    let trimmedEnd = end;
    while (trimmedStart < trimmedEnd && /\s/.test(sql[trimmedStart] ?? "")) trimmedStart += 1;
    while (trimmedEnd > trimmedStart && /\s/.test(sql[trimmedEnd - 1] ?? "")) trimmedEnd -= 1;
    if (trimmedStart < trimmedEnd) spans.push({ start: trimmedStart, end: trimmedEnd });
  };

  for (const token of tokenizeSqlSemantic(sql, dialectId)) {
    if (token.kind !== "punctuation" || token.text !== ";" || token.depth !== 0) continue;
    appendSpan(token.span.start);
    start = token.span.end;
  }
  appendSpan(sql.length);
  return spans;
}

export function quoteTableIdentifier(databaseType: DatabaseType | undefined, name: string): string {
  if ((databaseType === "gaussdb" || databaseType === "opengauss") && isExplicitlyQuotedSqlIdentifier(name)) return name;
  if (databaseType === "iotdb") return name;
  // JDBC connections use the driver-reported identifier quote string
  // (DatabaseMetaData.getIdentifierQuoteString()) — pass through unquoted.
  if (databaseType === "jdbc") return name;
  if (databaseType === "bigquery") return `\`${name.replace(/`/g, "\\`")}\``;
  // Cloud Spanner defaults to the GoogleSQL dialect (backticks). PostgreSQL-dialect
  // databases report `"` on connect and take the quoteTableDataIdentifier path.
  if (databaseType === "spanner") return `\`${name.replace(/`/g, "\\`")}\``;
  if (
    databaseType === "mysql" ||
    databaseType === "clickhouse" ||
    databaseType === "hive" ||
    databaseType === "argo" ||
    databaseType === "kyuubi" ||
    databaseType === "impala" ||
    databaseType === "spark" ||
    databaseType === "databricks" ||
    databaseType === "databend" ||
    databaseType === "tdengine" ||
    databaseType === "access" ||
    databaseType === "doris" ||
    databaseType === "starrocks" ||
    databaseType === "goldendb"
  )
    return `\`${name.replace(/`/g, "``")}\``;
  if (databaseType === "informix" && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) return name;
  if (databaseType === "neo4j") return quoteCypherIdentifier(name);
  if (databaseType === "sqlserver") return `[${name.replace(/\]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteTableDataIdentifier(databaseType: DatabaseType | undefined, name: string, identifierQuote?: string): string {
  if (databaseType === "jdbc" && identifierQuote != null) {
    if (!identifierQuote) return name;
    return `${identifierQuote}${name.replaceAll(identifierQuote, identifierQuote + identifierQuote)}${identifierQuote}`;
  }
  if ((databaseType === "gaussdb" || databaseType === "opengauss" || databaseType === "postgres") && identifierQuote != null) return quoteGaussDbJdbcIdentifier(name, identifierQuote);
  if ((databaseType === "kingbase" || databaseType === "informix" || databaseType === "spanner") && identifierQuote != null) {
    if (!identifierQuote) return name;
    return `${identifierQuote}${name.replaceAll(identifierQuote, identifierQuote + identifierQuote)}${identifierQuote}`;
  }
  return quoteTableIdentifier(databaseType, name);
}

function quoteCypherIdentifier(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

export function qualifiedTableName(options: Pick<BuildTableSelectSqlOptions, "databaseType" | "driverProfile" | "identifierQuote" | "schema" | "tableName" | "catalog" | "database" | "includeDatabaseName">): string {
  const { databaseType, driverProfile, identifierQuote, schema, tableName, catalog, database, includeDatabaseName } = options;
  if (databaseType === "informix" && driverProfile?.trim().toLowerCase() === "gbase8s") {
    return quoteTableDataIdentifier(databaseType, tableName, identifierQuote);
  }
  // Doris / StarRocks multi-catalog: address external-catalog tables with the
  // 3-part `catalog.database.table` form, which the engines accept directly.
  if (catalog && catalog !== "internal" && (databaseType === "doris" || databaseType === "starrocks")) {
    const quotedCatalog = quoteTableIdentifier(databaseType, catalog);
    const quotedTable = quoteTableIdentifier(databaseType, tableName);
    // Doris/StarRocks have no separate schema concept; the database under the
    // external catalog is the middle segment. Prefer schema when a caller
    // passes it that way, otherwise fall back to database.
    const middle = schema?.trim() || database?.trim();
    if (middle) {
      return `${quotedCatalog}.${quoteTableIdentifier(databaseType, middle)}.${quotedTable}`;
    }
    return `${quotedCatalog}.${quotedTable}`;
  }
  if (databaseType === "iotdb") {
    const trimmedSchema = schema?.trim();
    if (trimmedSchema && tableName !== trimmedSchema && !tableName.startsWith(`${trimmedSchema}.`)) {
      return `${quoteTableIdentifier(databaseType, trimmedSchema)}.${quoteTableIdentifier(databaseType, tableName)}`;
    }
    return quoteTableIdentifier(databaseType, tableName);
  }
  if ((databaseType === "gaussdb" || databaseType === "opengauss" || databaseType === "postgres" || databaseType === "kingbase") && identifierQuote != null) {
    const quotedTable = quoteTableDataIdentifier(databaseType, tableName, identifierQuote);
    const trimmedSchema = schema?.trim();
    if (trimmedSchema) {
      return `${quoteTableDataIdentifier(databaseType, trimmedSchema, identifierQuote)}.${quotedTable}`;
    }
    return quotedTable;
  }
  if (databaseType === "jdbc" && jdbcDriverProfileUsesSchemaQualification(driverProfile)) {
    const quotedTable = quoteTableDataIdentifier(databaseType, tableName, identifierQuote);
    const trimmedSchema = schema?.trim();
    return trimmedSchema ? `${quoteTableDataIdentifier(databaseType, trimmedSchema, identifierQuote)}.${quotedTable}` : quotedTable;
  }
  // Cloud Spanner mirrors `uses_connection_identifier_quote` on the backend, which
  // counts Spanner unconditionally: the branch must not be gated on a reported
  // quote, otherwise a connection whose quote has not loaded yet would fall through
  // to the SCHEMA_AWARE_TYPES path and silently drop the schema qualifier. A blank
  // schema (GoogleSQL's default) drops the dot separator with it, because
  // `` `s`.`t` `` with an empty `s` is a Spanner syntax error; a missing quote falls
  // back to the GoogleSQL backtick default, exactly like `identifiers.rs`.
  if (databaseType === "spanner") {
    const quotedTable = quoteTableDataIdentifier(databaseType, tableName, identifierQuote);
    // `database` holds the resource path `projects/{p}/instances/{i}/databases/{d}`, and callers
    // that treat the database as the schema (the sidebar SQL templates collapse
    // `node.schema || node.database`) would otherwise emit `` `projects/…`.`singers` ``. A Spanner
    // schema name is letters, digits and underscores, so the path separator identifies it.
    const trimmedSchema = schema?.trim();
    const schemaQualifier = trimmedSchema && !trimmedSchema.includes("/") ? trimmedSchema : undefined;
    return schemaQualifier ? `${quoteTableDataIdentifier(databaseType, schemaQualifier, identifierQuote)}.${quotedTable}` : quotedTable;
  }
  if (databaseType === "informix" && identifierQuote != null) {
    const quotedTable = quoteTableDataIdentifier(databaseType, tableName, identifierQuote);
    const trimmedSchema = schema?.trim();
    return trimmedSchema ? `${quoteTableDataIdentifier(databaseType, trimmedSchema, identifierQuote)}.${quotedTable}` : quotedTable;
  }
  if ((isSchemaAware(databaseType) || databaseType === "sqlite") && !usesDatabaseObjectTreeMode(databaseType) && schema) {
    if (databaseType === "sqlserver") {
      const linked = parseSqlServerLinkedSchema(schema);
      if (linked) return sqlServerLinkedTableName(linked, tableName);
    }
    return `${quoteTableIdentifier(databaseType, schema)}.${quoteTableIdentifier(databaseType, tableName)}`;
  }
  // MySQL-style engines use the selected database as their table namespace.
  // Keep this opt-in so existing generated SQL remains unchanged by default.
  const trimmedDatabase = database?.trim();
  if (includeDatabaseName && trimmedDatabase && databaseType && DATABASE_QUALIFIED_TABLE_TYPES.has(databaseType)) {
    return `${quoteTableIdentifier(databaseType, trimmedDatabase)}.${quoteTableIdentifier(databaseType, tableName)}`;
  }
  return quoteTableIdentifier(databaseType, tableName);
}

interface SqlCteVisibility {
  name: string;
  visibleFrom: number;
  visibleUntil: number;
}

function matchingSqlParenthesisToken(tokens: readonly SqlSemanticToken[], openIndex: number): number {
  const open = tokens[openIndex];
  if (open?.text !== "(") return -1;
  for (let index = openIndex + 1; index < tokens.length; index += 1) {
    if (tokens[index]?.text === ")" && tokens[index]?.depth === open.depth) return index;
  }
  return -1;
}

function sqlCteVisibilities(tokens: readonly SqlSemanticToken[], sqlLength: number): SqlCteVisibility[] {
  const visibilities: SqlCteVisibility[] = [];
  for (let withIndex = 0; withIndex < tokens.length; withIndex += 1) {
    const withToken = tokens[withIndex];
    if (withToken?.kind !== "word" || withToken.normalized !== "with") continue;
    const depth = withToken.depth;
    const scopeEnd = tokens.find((token, index) => index > withIndex && token.depth < depth)?.span.start ?? sqlLength;
    let index = withIndex + 1;
    if (tokens[index]?.depth === depth && tokens[index]?.normalized === "recursive") index += 1;

    while (index < tokens.length) {
      while (tokens[index]?.depth === depth && tokens[index]?.text === ",") index += 1;
      const nameToken = tokens[index];
      if (!nameToken || nameToken.depth !== depth || !tokenIsIdentifier(nameToken)) break;
      index += 1;

      if (tokens[index]?.depth === depth && tokens[index]?.text === "(") {
        const columnsClose = matchingSqlParenthesisToken(tokens, index);
        if (columnsClose < 0) break;
        index = columnsClose + 1;
      }
      if (tokens[index]?.depth === depth && tokens[index]?.normalized === "as") index += 1;
      if (tokens[index]?.depth !== depth || tokens[index]?.text !== "(") break;
      const bodyOpen = index;
      const bodyClose = matchingSqlParenthesisToken(tokens, bodyOpen);
      if (bodyClose < 0) break;
      visibilities.push({
        name: unquoteSqlSemanticIdentifier(nameToken),
        visibleFrom: tokens[bodyOpen]!.span.end,
        visibleUntil: scopeEnd,
      });
      index = bodyClose + 1;
      if (tokens[index]?.depth !== depth || tokens[index]?.text !== ",") break;
    }
  }
  return visibilities;
}

/**
 * Qualifies physical table sources shown in a result footer without changing
 * the SQL that was actually executed. The semantic model deliberately skips
 * CTE names, strings, and comments that can happen to contain FROM/JOIN text.
 */
export function qualifyTableReferencesInSql(sql: string, options: Pick<BuildTableSelectSqlOptions, "databaseType" | "database" | "includeDatabaseName">): string {
  if (!options.includeDatabaseName || !options.databaseType || !DATABASE_QUALIFIED_TABLE_TYPES.has(options.databaseType) || !options.database?.trim()) return sql;
  const database = quoteTableIdentifier(options.databaseType, options.database.trim());
  // Build replacements from right to left so that every semantic span still
  // points at the original source text. Only one-part physical table names
  // need the active database prefix; CTEs and already-qualified tables do not.
  const semanticOptions = {
    databaseType: options.databaseType,
    dialect: options.databaseType === "goldendb" ? "mysql" : undefined,
  } as const;
  const dialectId = sqlSemanticDialectFor(semanticOptions).id;
  const replacements = sqlStatementSpans(sql, dialectId)
    .flatMap(({ start, end }) => {
      const statementSql = sql.slice(start, end);
      const tokens = tokenizeSqlSemantic(statementSql, dialectId);
      const cteVisibilities = sqlCteVisibilities(tokens, statementSql.length);
      const isCteReference = (name: string, span: { start: number; end: number }): boolean => cteVisibilities.some((cte) => cte.name.toLowerCase() === name.toLowerCase() && span.start >= cte.visibleFrom && span.end <= cte.visibleUntil);
      const tokensBySpan = new Map(tokens.map((token) => [`${token.span.start}:${token.span.end}`, token]));

      return sqlSemanticTableNameSpans(statementSql, semanticOptions)
        .map((span) => ({ span, token: tokensBySpan.get(`${span.start}:${span.end}`) }))
        .filter(({ span, token }) => {
          if (!token || isCteReference(unquoteSqlSemanticIdentifier(token), span)) return false;
          // sqlSemanticTableNameSpans returns the final segment in a qualified
          // name, so a preceding dot identifies a database-qualified source.
          return !statementSql.slice(0, span.start).trimEnd().endsWith(".");
        })
        .map(({ span, token }) => ({
          span: { start: start + span.start, end: start + span.end },
          tableName: unquoteSqlSemanticIdentifier(token!),
        }));
    })
    .filter(({ span }, index, all) => all.findIndex((candidate) => candidate.span.start === span.start && candidate.span.end === span.end) === index)
    .sort((left, right) => right.span.start - left.span.start);

  return replacements.reduce((qualifiedSql, { span, tableName }) => `${qualifiedSql.slice(0, span.start)}${database}.${quoteTableIdentifier(options.databaseType, tableName)}${qualifiedSql.slice(span.end)}`, sql);
}

export function metricSelector(metricName: string): string {
  const escaped = metricName.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
  return `{__name__="${escaped}"}`;
}

export function metricRangeQuery(metricName: string, lookback = "1h"): string {
  return `${metricSelector(metricName)}[${lookback}]`;
}

export function normalizeWhereInput(whereInput?: string): string {
  const withoutSemicolon = whereInput?.trim().replace(/;+$/, "").trim() ?? "";
  return withoutSemicolon.replace(/^where\b/i, "").trim();
}

export async function buildTableSelectSql(options: BuildTableSelectSqlOptions): Promise<string> {
  if (options.databaseType === "victoriametrics") return metricRangeQuery(options.tableName);
  return api.buildTableSelectSql(options);
}
