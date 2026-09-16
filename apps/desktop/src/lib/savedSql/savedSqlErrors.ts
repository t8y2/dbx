interface SavedSqlErrorTranslator {
  (key: string, params?: Record<string, unknown>): string;
}

interface SavedSqlNameConflictLike {
  code?: unknown;
  fileName?: unknown;
  message?: unknown;
}

export function savedSqlErrorMessage(error: unknown, translate: SavedSqlErrorTranslator): string {
  const candidate = error as SavedSqlNameConflictLike | null;
  if (candidate?.code === "SAVED_SQL_NAME_CONFLICT" && typeof candidate.fileName === "string") {
    return translate("savedSql.nameConflict", { name: candidate.fileName });
  }
  if (typeof candidate?.message === "string") return candidate.message;
  return String(error);
}
