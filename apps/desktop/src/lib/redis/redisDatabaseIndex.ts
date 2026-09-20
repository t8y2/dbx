// Mirrors dbx-core `redis_database_index()` (crates/dbx-drivers/src/db/redis_driver.rs):
// a Redis database is a numeric index. Anything else (e.g. redis-cli flags like
// "0 --tls --insecure" pasted into the field or imported from a dirty URL) fails
// to parse on the backend and silently falls back to db 0, so every frontend
// surface must present the index the connection actually uses.
const REDIS_DATABASE_INDEX_PATTERN = /^[+-]?\d+$/;

/** Returns the numeric Redis database index a stored value resolves to; dirty values fall back to "0". */
export function effectiveRedisDatabaseIndex(database: string | null | undefined): string {
  const trimmed = String(database ?? "").trim();
  return trimmed && REDIS_DATABASE_INDEX_PATTERN.test(trimmed) ? trimmed : "0";
}

/**
 * Cleans a Redis database value for storage: numeric indexes pass through
 * (trimmed), dirty non-numeric values collapse to the index the backend
 * actually uses, and empty values stay unset.
 */
export function normalizeRedisDatabaseValue(database: string | null | undefined): string | undefined {
  const trimmed = String(database ?? "").trim();
  if (!trimmed) return undefined;
  return REDIS_DATABASE_INDEX_PATTERN.test(trimmed) ? trimmed : "0";
}
