import * as api from "@/lib/api";

export const SQLITE_DATABASE_FILE_EXTENSIONS = ["db", "db3", "sqlite", "sqlite3", "sqlitedb"];

const SQLITE_DATABASE_EXTENSION_SET = new Set(SQLITE_DATABASE_FILE_EXTENSIONS.map((extension) => `.${extension}`));

export function databaseTypeFromKnownExtension(path: string): "sqlite" | "duckdb" | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".duckdb")) return "duckdb";
  if ([...SQLITE_DATABASE_EXTENSION_SET].some((extension) => lower.endsWith(extension))) return "sqlite";
  return null;
}

export async function detectDatabaseFileType(path: string): Promise<"sqlite" | "duckdb" | null> {
  const knownType = databaseTypeFromKnownExtension(path);
  if (knownType) return knownType;
  return (await api.isSqliteDatabaseFile(path).catch(() => false)) ? "sqlite" : null;
}
