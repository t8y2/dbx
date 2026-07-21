import type { DatabaseType } from "@/types/database";

export interface SqlSemanticProjectionAliasVisibility {
  where: boolean;
  groupBy: boolean;
  having: boolean;
  orderBy: boolean;
}

export interface SqlSemanticDialectAdapter {
  id: string;
  identifierQuotes: Array<{ open: string; close: string }>;
  supportsAsForTableAlias: boolean;
  projectionAliasVisibility: SqlSemanticProjectionAliasVisibility;
  normalizeIdentifier(identifier: string, quoted?: boolean): string;
  quoteIdentifier(identifier: string): string;
  qualifierRole(parts: string[], context: "table" | "column" | "routine"): "catalog" | "schema" | "table" | "package" | "unknown";
}

function quoteWith(identifier: string, quote: string): string {
  return `${quote}${identifier.replaceAll(quote, quote + quote)}${quote}`;
}

function defaultNormalize(identifier: string): string {
  return identifier;
}

function lowerUnquoted(identifier: string, quoted?: boolean): string {
  return quoted ? identifier : identifier.toLowerCase();
}

function upperUnquoted(identifier: string, quoted?: boolean): string {
  return quoted ? identifier : identifier.toUpperCase();
}

const defaultProjectionAliasVisibility: SqlSemanticProjectionAliasVisibility = {
  where: false,
  groupBy: false,
  having: false,
  orderBy: true,
};

function roleForGenericQualifier(parts: string[], context: "table" | "column" | "routine"): "catalog" | "schema" | "table" | "package" | "unknown" {
  if (parts.length <= 0) return "unknown";
  if (context === "column") return parts.length >= 2 ? "table" : "table";
  if (context === "routine") return parts.length >= 2 ? "package" : "schema";
  if (parts.length >= 2) return "schema";
  return "schema";
}

export const SQL_SEMANTIC_DIALECTS: Record<string, SqlSemanticDialectAdapter> = {
  generic: {
    id: "generic",
    identifierQuotes: [{ open: '"', close: '"' }],
    supportsAsForTableAlias: true,
    projectionAliasVisibility: defaultProjectionAliasVisibility,
    normalizeIdentifier: defaultNormalize,
    quoteIdentifier: (identifier) => quoteWith(identifier, '"'),
    qualifierRole: roleForGenericQualifier,
  },
  postgres: {
    id: "postgres",
    identifierQuotes: [{ open: '"', close: '"' }],
    supportsAsForTableAlias: true,
    projectionAliasVisibility: defaultProjectionAliasVisibility,
    normalizeIdentifier: lowerUnquoted,
    quoteIdentifier: (identifier) => quoteWith(identifier, '"'),
    qualifierRole: roleForGenericQualifier,
  },
  mysql: {
    id: "mysql",
    identifierQuotes: [
      { open: "`", close: "`" },
      { open: '"', close: '"' },
    ],
    supportsAsForTableAlias: true,
    projectionAliasVisibility: { where: false, groupBy: true, having: true, orderBy: true },
    normalizeIdentifier: defaultNormalize,
    quoteIdentifier: (identifier) => quoteWith(identifier, "`"),
    qualifierRole(parts, context) {
      if (context === "column") return parts.length >= 2 ? "table" : "table";
      if (context === "routine") return parts.length >= 2 ? "package" : "schema";
      return parts.length >= 1 ? "schema" : "unknown";
    },
  },
  sqlserver: {
    id: "sqlserver",
    identifierQuotes: [
      { open: "[", close: "]" },
      { open: '"', close: '"' },
    ],
    supportsAsForTableAlias: true,
    projectionAliasVisibility: defaultProjectionAliasVisibility,
    normalizeIdentifier: defaultNormalize,
    quoteIdentifier: (identifier) => `[${identifier.replaceAll("]", "]]")}]`,
    qualifierRole(parts, context) {
      if (context === "column") return parts.length >= 2 ? "table" : "table";
      if (context === "routine") return parts.length >= 2 ? "package" : "schema";
      if (parts.length >= 2) return "schema";
      return "schema";
    },
  },
  sqlite: {
    id: "sqlite",
    identifierQuotes: [
      { open: '"', close: '"' },
      { open: "`", close: "`" },
      { open: "[", close: "]" },
    ],
    supportsAsForTableAlias: true,
    projectionAliasVisibility: { where: false, groupBy: true, having: true, orderBy: true },
    normalizeIdentifier: defaultNormalize,
    quoteIdentifier: (identifier) => quoteWith(identifier, '"'),
    qualifierRole: roleForGenericQualifier,
  },
  duckdb: {
    id: "duckdb",
    identifierQuotes: [{ open: '"', close: '"' }],
    supportsAsForTableAlias: true,
    projectionAliasVisibility: defaultProjectionAliasVisibility,
    normalizeIdentifier: defaultNormalize,
    quoteIdentifier: (identifier) => quoteWith(identifier, '"'),
    qualifierRole: roleForGenericQualifier,
  },
  oracle: {
    id: "oracle",
    identifierQuotes: [{ open: '"', close: '"' }],
    supportsAsForTableAlias: false,
    projectionAliasVisibility: defaultProjectionAliasVisibility,
    normalizeIdentifier: upperUnquoted,
    quoteIdentifier: (identifier) => quoteWith(identifier, '"'),
    qualifierRole(parts, context) {
      if (context === "column") return parts.length >= 2 ? "table" : "table";
      if (context === "routine") return parts.length >= 2 ? "package" : "schema";
      return parts.length >= 1 ? "schema" : "unknown";
    },
  },
};

export function sqlReferenceAnalysisDialectFor(options: { databaseType?: DatabaseType; identifierQuote?: string; fallbackDialect: string }): string {
  if (options.databaseType === "kingbase" && options.identifierQuote === "`") return "mysql";
  return options.fallbackDialect;
}

export function sqlSemanticDialectFor(options: { databaseType?: DatabaseType; dialect?: "mysql" | "postgres" | "sqlserver" }): SqlSemanticDialectAdapter {
  if (options.dialect && SQL_SEMANTIC_DIALECTS[options.dialect]) return SQL_SEMANTIC_DIALECTS[options.dialect];
  switch (options.databaseType) {
    case "postgres":
    case "redshift":
    case "opengauss":
    case "gaussdb":
    case "highgo":
      return SQL_SEMANTIC_DIALECTS.postgres;
    case "mysql":
    case "doris":
    case "starrocks":
      return SQL_SEMANTIC_DIALECTS.mysql;
    case "sqlserver":
      return SQL_SEMANTIC_DIALECTS.sqlserver;
    case "sqlite":
    case "rqlite":
    case "turso":
    case "cloudflare-d1":
      return SQL_SEMANTIC_DIALECTS.sqlite;
    case "duckdb":
      return SQL_SEMANTIC_DIALECTS.duckdb;
    case "oracle":
    case "oceanbase-oracle":
    case "dameng":
    case "kingbase":
    case "vastbase":
    case "goldendb":
    case "yashandb":
      return SQL_SEMANTIC_DIALECTS.oracle;
    default:
      return SQL_SEMANTIC_DIALECTS.generic;
  }
}
