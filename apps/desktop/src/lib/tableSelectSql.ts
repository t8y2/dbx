import type { DatabaseType } from "../types/database.ts";
import { isSchemaAware, usesDatabaseObjectTreeMode } from "./databaseCapabilities.ts";
import * as api from "./api.ts";

export interface BuildTableSelectSqlOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName: string;
  primaryKeys?: string[];
  columns?: string[];
  fallbackOrderColumns?: string[];
  orderBy?: string;
  limit?: number;
  offset?: number;
  whereInput?: string;
  includeRowId?: boolean;
}

export function quoteTableIdentifier(databaseType: DatabaseType | undefined, name: string): string {
  if (databaseType === "iotdb") return name;
  if (databaseType === "jdbc") return quoteJdbcIdentifier(name);
  if (databaseType === "mysql" || databaseType === "hive" || databaseType === "databend" || databaseType === "tdengine" || databaseType === "access") return `\`${name.replace(/`/g, "``")}\``;
  if (databaseType === "informix" && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) return name;
  if (databaseType === "neo4j") return quoteCypherIdentifier(name);
  if (databaseType === "sqlserver") return `[${name.replace(/\]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteCypherIdentifier(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function quoteJdbcIdentifier(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) return name;
  return `\`${name.replace(/`/g, "``")}\``;
}

export function qualifiedTableName(options: Pick<BuildTableSelectSqlOptions, "databaseType" | "schema" | "tableName">): string {
  const { databaseType, schema, tableName } = options;
  if (databaseType === "iotdb") {
    const trimmedSchema = schema?.trim();
    if (trimmedSchema && tableName !== trimmedSchema && !tableName.startsWith(`${trimmedSchema}.`)) {
      return `${quoteTableIdentifier(databaseType, trimmedSchema)}.${quoteTableIdentifier(databaseType, tableName)}`;
    }
    return quoteTableIdentifier(databaseType, tableName);
  }
  if (isSchemaAware(databaseType) && !usesDatabaseObjectTreeMode(databaseType) && schema) {
    return `${quoteTableIdentifier(databaseType, schema)}.${quoteTableIdentifier(databaseType, tableName)}`;
  }
  return quoteTableIdentifier(databaseType, tableName);
}

export function normalizeWhereInput(whereInput?: string): string {
  const withoutSemicolon = whereInput?.trim().replace(/;+$/, "").trim() ?? "";
  return withoutSemicolon.replace(/^where\b/i, "").trim();
}

export async function buildTableSelectSql(options: BuildTableSelectSqlOptions): Promise<string> {
  return api.buildTableSelectSql(options);
}
