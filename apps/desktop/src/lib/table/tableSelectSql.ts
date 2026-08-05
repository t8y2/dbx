import type { DatabaseType } from "@/types/database.ts";
import { isSchemaAware, usesDatabaseObjectTreeMode } from "@/lib/database/databaseCapabilities.ts";
import * as api from "@/lib/backend/api.ts";
import { parseSqlServerLinkedSchema, sqlServerLinkedTableName } from "@/lib/database/sqlServerLinkedServers.ts";
import { isExplicitlyQuotedSqlIdentifier, quoteGaussDbJdbcIdentifier } from "@/lib/sql/sqlIdentifier.ts";

export interface BuildTableSelectSqlOptions {
  databaseType?: DatabaseType;
  identifierQuote?: string;
  schema?: string;
  tableName: string;
  tableType?: string;
  primaryKeys?: string[];
  columns?: string[];
  fallbackOrderColumns?: string[];
  orderBy?: string;
  limit?: number;
  offset?: number;
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
  if (databaseType === "mysql" || databaseType === "clickhouse" || databaseType === "hive" || databaseType === "spark" || databaseType === "databend" || databaseType === "tdengine" || databaseType === "access" || databaseType === "doris" || databaseType === "starrocks")
    return `\`${name.replace(/`/g, "``")}\``;
  if (databaseType === "informix" && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) return name;
  if (databaseType === "neo4j") return quoteCypherIdentifier(name);
  if (databaseType === "sqlserver") return `[${name.replace(/\]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteTableDataIdentifier(databaseType: DatabaseType | undefined, name: string, identifierQuote?: string): string {
  if ((databaseType === "gaussdb" || databaseType === "opengauss" || databaseType === "postgres") && identifierQuote != null) return quoteGaussDbJdbcIdentifier(name, identifierQuote);
  if ((databaseType === "kingbase" || databaseType === "informix") && identifierQuote != null) {
    if (!identifierQuote) return name;
    return `${identifierQuote}${name.replaceAll(identifierQuote, identifierQuote + identifierQuote)}${identifierQuote}`;
  }
  return quoteTableIdentifier(databaseType, name);
}

function quoteCypherIdentifier(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

export function qualifiedTableName(options: Pick<BuildTableSelectSqlOptions, "databaseType" | "identifierQuote" | "schema" | "tableName" | "catalog" | "database">): string {
  const { databaseType, identifierQuote, schema, tableName, catalog, database } = options;
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
