import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { h2FilePathFromJdbcUrl } from "@/lib/h2Connection";

/**
 * Whether the database type is one that (potentially) backs onto a local file.
 * This is a type-level check only — it does not verify that a valid path is
 * configured. Use this to decide whether to show file-path UI; use
 * `isLocalFileDb` / `connectionFilePath` to decide whether a reveal action is
 * available.
 */
export function isLocalFileTypeDb(dbType: DatabaseType | string): boolean {
  return dbType === "sqlite" || dbType === "duckdb" || dbType === "access" || dbType === "h2";
}

/**
 * Extract the on-disk file path of a connection if (and only if) the
 * connection backs onto a single local file.
 *
 * - SQLite / DuckDB / Access: `host` holds the file path.
 * - H2 file mode: path is parsed out of the JDBC URL via `h2FilePathFromJdbcUrl`.
 *   H2 stores its data in `<base>.mv.db` (default) or `<base>.h2.db`; we hand
 *   back the base path the user actually configured so the Tauri side can try
 *   reasonable variants when the literal path isn't a file.
 *
 * Returns `null` for in-memory (`:memory:`), empty paths, H2 server/mem mode,
 * and any DB type that isn't local-file.
 */
export function connectionFilePath(config: Pick<ConnectionConfig, "db_type" | "host" | "connection_string">): string | null {
  const dbType = config.db_type;
  if (dbType === "sqlite" || dbType === "duckdb" || dbType === "access") {
    const host = (config.host ?? "").trim();
    if (!host || host === ":memory:") return null;
    return host;
  }
  if (dbType === "h2") {
    const fromUrl = h2FilePathFromJdbcUrl(config.connection_string);
    const trimmed = (fromUrl ?? "").trim();
    if (!trimmed) return null;
    return trimmed;
  }
  return null;
}

/**
 * Whether the connection has a meaningful local file path that can be revealed
 * in the OS file manager. True iff `connectionFilePath` returns non-null.
 */
export function isLocalFileDb(config: Pick<ConnectionConfig, "db_type" | "host" | "connection_string">): boolean {
  return connectionFilePath(config) !== null;
}

export function isMemorySqlitePath(path: string | undefined | null): boolean {
  return (path ?? "").trim().toLowerCase() === ":memory:";
}

export function sqliteBackupSourcePath(config: Pick<ConnectionConfig, "db_type" | "host">): string | null {
  if (config.db_type !== "sqlite") return null;
  const host = (config.host ?? "").trim();
  return host || null;
}

export function defaultSqliteBackupFileName(config: Pick<ConnectionConfig, "host" | "name">): string {
  const source = (config.host || config.name || "database").trim();
  const rawFileName = isMemorySqlitePath(source) ? "memory.db" : source.split(/[\\/]/).filter(Boolean).pop() || "database.db";
  const fileName = sanitizeFileName(rawFileName) || "database.db";
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) return `${fileName}.backup.db`;
  return `${fileName.slice(0, dotIndex)}.backup${fileName.slice(dotIndex)}`;
}

function sanitizeFileName(fileName: string): string {
  return fileName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "");
}
