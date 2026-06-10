import type { DatabaseType } from "@/types/database";
import * as api from "@/lib/api";

const MYSQL_COMPATIBLE_PROFILES = new Set(["mysql", "mariadb", "tidb", "oceanbase", "doris", "starrocks", "custom_mysql"]);
const MYSQL_COMPATIBLE_TYPES = new Set<DatabaseType>(["mysql", "doris", "starrocks", "goldendb"]);

export interface CreateDatabaseSqlOptions {
  databaseType?: DatabaseType;
  driverProfile?: string | null;
  name: string;
  charset?: string;
  collation?: string;
}

export function supportsCreateDatabaseCharset(databaseType?: DatabaseType, driverProfile?: string | null): boolean {
  return MYSQL_COMPATIBLE_TYPES.has(databaseType as DatabaseType) || (!!driverProfile && MYSQL_COMPATIBLE_PROFILES.has(driverProfile));
}

export function buildCreateDatabaseSql(options: CreateDatabaseSqlOptions): Promise<string> {
  return api.buildCreateDatabaseSql(options);
}

export function buildDuckDbAttachDatabaseSql(path: string, name: string): Promise<string> {
  return api.buildDuckDbAttachDatabaseSql(path, name);
}

export function duckDbAttachedDatabaseNameFromPath(path: string): string {
  const fileName = path.split(/[\\/]/).pop() ?? "";
  const withoutExtension = fileName.replace(/\.[^.\\/]+$/, "");
  const normalized = withoutExtension
    .trim()
    .replace(/[^\p{L}\p{N}_]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "duckdb_database";
}

export function uniqueDuckDbAttachedDatabaseName(baseName: string, existingNames: string[]): string {
  const existing = new Set(existingNames.map((name) => name.toLowerCase()));
  if (!existing.has(baseName.toLowerCase())) return baseName;
  for (let index = 2; index < Number.MAX_SAFE_INTEGER; index++) {
    const candidate = `${baseName}_${index}`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return `${baseName}_${Date.now()}`;
}
