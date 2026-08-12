import type { DatabaseType } from "@/types/database.ts";
import { isSchemaAware, usesDatabaseObjectTreeMode } from "@/lib/database/databaseCapabilities.ts";
import * as api from "@/lib/backend/api.ts";
import { parseSqlServerLinkedSchema, sqlServerLinkedTableName } from "@/lib/database/sqlServerLinkedServers.ts";
import { isExplicitlyQuotedSqlIdentifier, quoteGaussDbJdbcIdentifier } from "@/lib/sql/sqlIdentifier.ts";

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
    databaseType === "kyuubi" ||
    databaseType === "impala" ||
    databaseType === "spark" ||
    databaseType === "databend" ||
    databaseType === "tdengine" ||
    databaseType === "access" ||
    databaseType === "doris" ||
    databaseType === "starrocks"
  )
    return `\`${name.replace(/`/g, "``")}\``;
  if (databaseType === "informix" && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) return name;
  if (databaseType === "neo4j") return quoteCypherIdentifier(name);
  if (databaseType === "sqlserver") return `[${name.replace(/\]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteTableDataIdentifier(databaseType: DatabaseType | undefined, name: string, identifierQuote?: string): string {
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

export function qualifiedTableName(options: Pick<BuildTableSelectSqlOptions, "databaseType" | "driverProfile" | "identifierQuote" | "schema" | "tableName" | "catalog" | "database">): string {
  const { databaseType, driverProfile, identifierQuote, schema, tableName, catalog, database } = options;
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
  return quoteTableIdentifier(databaseType, tableName);
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
