import type { DatabaseType } from "@/types/database";
import { quotePostgresIdentifier } from "@/lib/database/databaseUserAdmin";

export type DatabaseOwnerObject = "database" | "schema";

// PG-family dialects that DBX already queries with pg_catalog.pg_get_userbyid(datdba)
// for database rename preflight, so ALTER ... OWNER TO shares the same catalog support.
const POSTGRES_OWNER_TYPES = new Set<DatabaseType>(["postgres", "gaussdb", "kwdb", "opengauss", "kingbase", "highgo", "uxdb", "vastbase"]);

export function supportsOwnerEditing(databaseType?: DatabaseType): boolean {
  return !!databaseType && POSTGRES_OWNER_TYPES.has(databaseType);
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildDatabaseOwnerSql(database: string, owner: string): string {
  return `ALTER DATABASE ${quotePostgresIdentifier(database)} OWNER TO ${quotePostgresIdentifier(owner)};`;
}

export function buildSchemaOwnerSql(schema: string, owner: string): string {
  return `ALTER SCHEMA ${quotePostgresIdentifier(schema)} OWNER TO ${quotePostgresIdentifier(owner)};`;
}

export function buildGetDatabaseOwnerSql(database: string): string {
  return `SELECT pg_catalog.pg_get_userbyid(datdba) AS owner FROM pg_catalog.pg_database WHERE datname = ${quoteSqlLiteral(database)};`;
}

export function buildGetSchemaOwnerSql(schema: string): string {
  return `SELECT pg_catalog.pg_get_userbyid(nspowner) AS owner FROM pg_catalog.pg_namespace WHERE nspname = ${quoteSqlLiteral(schema)};`;
}
