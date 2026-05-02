import type { DatabaseType } from "../types/database.ts";

export interface BuildTableSelectSqlOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName: string;
  primaryKeys?: string[];
  orderBy?: string;
  limit?: number;
  offset?: number;
  whereInput?: string;
}

export function quoteTableIdentifier(databaseType: DatabaseType | undefined, name: string): string {
  if (databaseType === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

export function qualifiedTableName(options: Pick<BuildTableSelectSqlOptions, "databaseType" | "schema" | "tableName">): string {
  const { databaseType, schema, tableName } = options;
  if ((databaseType === "postgres" || databaseType === "oracle" || databaseType === "sqlserver") && schema) {
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
    : undefined;
  const orderBy = options.orderBy ?? defaultOrderBy;
  const order = orderBy ? ` ORDER BY ${orderBy}` : "";

  if (databaseType === "oracle") {
    const offset = options.offset ? ` OFFSET ${options.offset} ROWS` : "";
    return `SELECT * FROM ${table}${where}${order}${offset} FETCH FIRST ${limit} ROWS ONLY`;
  }

  if (databaseType === "sqlserver") {
    return `SELECT TOP ${limit} * FROM ${table}${where}${order}`;
  }

  const offset = options.offset ? ` OFFSET ${options.offset}` : "";
  return `SELECT * FROM ${table}${where}${order} LIMIT ${limit}${offset};`;
}
