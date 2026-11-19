/**
 * PostgreSQL-family engines (PostgreSQL, openGauss, GaussDB, Kingbase, ...) refuse
 * `DROP DATABASE` while other sessions are connected. DBX already disconnects its own
 * sessions first, so this error always names someone else's connection; the raw text
 * mixes engine-specific force commands and DBX's own diagnostics notice (#13733).
 */
const DATABASE_IN_USE_PATTERN = /\bdatabase\s+"(?:[^"]|"")*"\s+is being accessed by other users\b/i;
const OTHER_SESSION_COUNT_PATTERN = /\bthere (?:is|are) (\d+) other sessions? using the database\b/i;

/**
 * `undefined` when `message` is not the "database is in use" error; otherwise the number of
 * other sessions the engine reported, or `null` when it did not report one (for example a
 * prepared transaction holds the database instead).
 */
export function dropDatabaseOtherSessionCount(message: string): number | null | undefined {
  if (!DATABASE_IN_USE_PATTERN.test(message)) return undefined;
  const count = OTHER_SESSION_COUNT_PATTERN.exec(message)?.[1];
  return count === undefined ? null : Number(count);
}
