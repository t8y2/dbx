export function isSqlFilePath(path: string): boolean {
  return /\.sql$/i.test(path.trim());
}

export function sqlFileTitleFromPath(path: string): string {
  const normalized = normalizeExternalSqlPath(path);
  const name = normalized.split("/").filter(Boolean).pop();
  return name || "script.sql";
}

export function normalizeExternalSqlPath(path: string): string {
  const normalized = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}

export function externalSqlFileDisplayTitles(paths: string[]): string[] {
  const segments = paths.map((path) => normalizeExternalSqlPath(path).split("/").filter(Boolean));
  const titles = segments.map((parts) => parts[parts.length - 1] || "script.sql");
  const collisions = new Map<string, number[]>();

  titles.forEach((title, index) => {
    const indexes = collisions.get(title) ?? [];
    indexes.push(index);
    collisions.set(title, indexes);
  });

  for (const indexes of collisions.values()) {
    if (indexes.length < 2) continue;
    const maxDepth = Math.max(...indexes.map((index) => segments[index].length));
    for (let depth = 2; depth <= maxDepth; depth++) {
      const candidates = indexes.map((index) => segments[index].slice(-depth).join("/"));
      if (new Set(candidates).size !== candidates.length) continue;
      indexes.forEach((index, candidateIndex) => {
        titles[index] = candidates[candidateIndex];
      });
      break;
    }
  }

  return titles;
}

export function externalSqlFilePaths(paths: string[]): string[] {
  return paths.filter(isSqlFilePath);
}

export const MAX_EXTERNAL_SQL_EDITOR_FILE_BYTES = 64 * 1024 * 1024;

export class ExternalSqlFileTooLargeError extends Error {
  constructor(
    readonly sizeBytes: number,
    readonly maxSizeBytes: number,
  ) {
    super("SQL file is too large to open in the editor");
    this.name = "ExternalSqlFileTooLargeError";
  }
}

export function isExternalSqlFileTooLargeError(error: unknown): error is ExternalSqlFileTooLargeError {
  return error instanceof ExternalSqlFileTooLargeError;
}

export function readBrowserSqlFile(file: Blob): Promise<string> {
  if (file.size > MAX_EXTERNAL_SQL_EDITOR_FILE_BYTES) {
    return Promise.reject(new ExternalSqlFileTooLargeError(file.size, MAX_EXTERNAL_SQL_EDITOR_FILE_BYTES));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Failed to read SQL file as text"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read SQL file"));
    reader.onabort = () => reject(new Error("SQL file read was cancelled"));
    reader.readAsText(file);
  });
}

export function formatSqlFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

export function externalSqlFileOpenErrorMessage(error: unknown, translate: (key: string, params: { size: string; limit: string }) => string): string {
  if (isExternalSqlFileTooLargeError(error)) {
    return translate("sqlFile.tooLargeForEditor", {
      size: formatSqlFileSize(error.sizeBytes),
      limit: formatSqlFileSize(error.maxSizeBytes),
    });
  }
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
}
