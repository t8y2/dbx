export function isSqlFilePath(path: string): boolean {
  return /\.sql$/i.test(path.trim());
}

export function sqlFileTitleFromPath(path: string): string {
  const trimmed = path.trim();
  const normalized = trimmed.replace(/\\/g, "/");
  const name = normalized.split("/").filter(Boolean).pop();
  return name || "script.sql";
}

export function externalSqlFilePaths(paths: string[]): string[] {
  return paths.filter(isSqlFilePath);
}
