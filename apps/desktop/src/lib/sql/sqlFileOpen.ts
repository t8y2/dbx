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
