import type { DatabaseType } from "../types/database.ts";
import { isSchemaAware, usesFetchFirst } from "./databaseCapabilities.ts";

export interface BuildTableSelectSqlOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName: string;
  primaryKeys?: string[];
  fallbackOrderColumns?: string[];
  orderBy?: string;
  limit?: number;
  offset?: number;
  whereInput?: string;
}

export function quoteTableIdentifier(databaseType: DatabaseType | undefined, name: string): string {
  if (databaseType === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  if (databaseType === "sqlserver") return `[${name.replace(/\]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

export function qualifiedTableName(
  options: Pick<BuildTableSelectSqlOptions, "databaseType" | "schema" | "tableName">,
): string {
  const { databaseType, schema, tableName } = options;
  if (isSchemaAware(databaseType) && schema) {
    return `${quoteTableIdentifier(databaseType, schema)}.${quoteTableIdentifier(databaseType, tableName)}`;
  }
  return quoteTableIdentifier(databaseType, tableName);
}

export function normalizeWhereInput(whereInput?: string): string {
  const withoutSemicolon = whereInput?.trim().replace(/;+$/, "").trim() ?? "";
  return withoutSemicolon.replace(/^where\b/i, "").trim();
}

export function buildTableSelectSql(options: BuildTableSelectSqlOptions): string {
  const databaseType = options.databaseType;
  const limit = options.limit ?? 100;
  const table = qualifiedTableName(options);
  const predicate = normalizeWhereInput(options.whereInput);
  const where = predicate ? ` WHERE (${predicate})` : "";
  const defaultOrderBy = options.primaryKeys?.length
    ? options.primaryKeys.map((pk) => `${quoteTableIdentifier(databaseType, pk)} ASC`).join(", ")
    : options.fallbackOrderColumns?.length
      ? options.fallbackOrderColumns.map((column) => `${quoteTableIdentifier(databaseType, column)} ASC`).join(", ")
      : undefined;
  const orderBy = options.orderBy ?? defaultOrderBy;
  const order = orderBy ? ` ORDER BY ${orderBy}` : "";

  if (usesFetchFirst(databaseType)) {
    const offset = options.offset ? ` OFFSET ${options.offset} ROWS` : "";
    return `SELECT * FROM ${table}${where}${order}${offset} FETCH FIRST ${limit} ROWS ONLY`;
  }

  if (databaseType === "sqlserver") {
    const stableOrder = order || " ORDER BY (SELECT NULL)";
    return `SELECT * FROM ${table}${where}${stableOrder} OFFSET ${options.offset ?? 0} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }

  const offset = options.offset ? ` OFFSET ${options.offset}` : "";
  return `SELECT * FROM ${table}${where}${order} LIMIT ${limit}${offset};`;
}
