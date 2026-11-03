/**
 * Persistence and retrieval for SQL file execution dialog options.
 */

export const SQL_FILE_CLOSE_ON_SUCCESS_STORAGE_KEY = "dbx-sql-file-close-on-success";

/**
 * Returns whether the SQL file execution dialog should close on successful completion.
 * Defaults to true if unconfigured.
 */
export function readSqlFileCloseOnSuccess(storage: Storage | undefined = typeof localStorage === "undefined" ? undefined : localStorage): boolean {
  try {
    const stored = storage?.getItem(SQL_FILE_CLOSE_ON_SUCCESS_STORAGE_KEY);
    return stored === null || stored === undefined ? true : stored === "true";
  } catch {
    return true;
  }
}

/**
 * Persists the close-on-success preference for SQL file execution.
 */
export function writeSqlFileCloseOnSuccess(enabled: boolean, storage: Storage | undefined = typeof localStorage === "undefined" ? undefined : localStorage): void {
  try {
    storage?.setItem(SQL_FILE_CLOSE_ON_SUCCESS_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore storage quota or access errors.
  }
}
