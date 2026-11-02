interface SavedSqlErrorTranslator {
  (key: string, params?: Record<string, unknown>): string;
}

interface SavedSqlNameConflictLike {
  code?: unknown;
  fileName?: unknown;
  message?: unknown;
}

export interface SavedSqlBatchFailureLike {
  fileName: string;
  error: unknown;
}

export function savedSqlErrorMessage(error: unknown, translate: SavedSqlErrorTranslator): string {
  const candidate = error as SavedSqlNameConflictLike | null;
  if (candidate?.code === "SAVED_SQL_NAME_CONFLICT" && typeof candidate.fileName === "string") {
    return translate("savedSql.nameConflict", { name: candidate.fileName });
  }
  if (typeof candidate?.message === "string") return candidate.message;
  return String(error);
}

export function savedSqlBatchErrorMessage(failures: readonly SavedSqlBatchFailureLike[], translate: SavedSqlErrorTranslator, limit = 3): string {
  const visible = failures.slice(0, limit).map((failure) => `${failure.fileName}: ${savedSqlErrorMessage(failure.error, translate)}`);
  const remaining = failures.length - visible.length;
  if (remaining > 0) visible.push(`… (+${remaining})`);
  return visible.join("; ");
}
