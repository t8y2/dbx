import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { normalizeExternalSqlPath, relocateExternalSqlPathWithinFolder } from "@/lib/sql/sqlFileOpen";

const STORAGE_KEY = "dbx-sql-file-manual-order";
export type SqlFileOrder = Record<string, string[]>;

export function sqlFileParentPath(path: string): string {
  const normalized = normalizeExternalSqlPath(path);
  const separator = normalized.lastIndexOf("/");
  return separator === 0 ? "/" : normalized.slice(0, separator);
}

export function getSqlFileOrder(): SqlFileOrder {
  const result: SqlFileOrder = Object.create(null);
  try {
    const stored = JSON.parse(safeLocalStorageGet(STORAGE_KEY) || "null");
    if (stored?.version !== 1 || !stored.directories || typeof stored.directories !== "object" || Array.isArray(stored.directories)) return result;
    for (const [directory, paths] of Object.entries(stored.directories)) {
      if (!Array.isArray(paths)) continue;
      const parent = normalizeExternalSqlPath(directory);
      const files = paths
        .filter((path): path is string => typeof path === "string" && !!path.trim())
        .map(normalizeExternalSqlPath)
        .filter((path) => sqlFileParentPath(path) === parent);
      if (files.length) result[parent] = [...new Set(files)];
    }
  } catch {
    // An invalid preference must not prevent the file tree from opening.
  }
  return result;
}

export function saveSqlFileOrder(order: SqlFileOrder): boolean {
  return safeLocalStorageSet(STORAGE_KEY, JSON.stringify({ version: 1, directories: order }));
}

/** Keep filtered-out paths: a scanner result is not a complete directory inventory. */
export function reorderSqlFiles(order: SqlFileOrder, siblings: readonly string[], sourcePath: string, targetPath: string, position: "before" | "after"): SqlFileOrder | null {
  const source = normalizeExternalSqlPath(sourcePath);
  const target = normalizeExternalSqlPath(targetPath);
  const parent = sqlFileParentPath(source);
  const visible = [...new Set(siblings.map(normalizeExternalSqlPath))];
  if (source === target || parent !== sqlFileParentPath(target) || !visible.includes(source) || !visible.includes(target)) return null;
  if (visible.some((path) => sqlFileParentPath(path) !== parent)) return null;
  // Start from the displayed order, including when dragging out of a name sort.
  // Replace only visible slots so filtered-out files keep their relative order.
  const visiblePaths = new Set(visible);
  let visibleIndex = 0;
  const merged = [...new Set(order[parent] ?? [])].map((path) => (visiblePaths.has(path) ? visible[visibleIndex++] : path));
  merged.push(...visible.slice(visibleIndex));
  const reordered = merged.filter((path) => path !== source);
  const index = reordered.indexOf(target);
  reordered.splice(index + (position === "after" ? 1 : 0), 0, source);
  return { ...order, [parent]: reordered };
}

/** Only explicit successful mutations can remove paths or migrate their identities. */
export function remapSqlFileOrder(order: SqlFileOrder, previousPath: string, nextPath?: string, directory = false): SqlFileOrder {
  const previous = normalizeExternalSqlPath(previousPath);
  let changed = false;
  const mapPath = (path: string): string | null => {
    if (path !== previous && !(directory && path.startsWith(`${previous}/`))) return path;
    changed = true;
    if (!nextPath) return null;
    return directory ? normalizeExternalSqlPath(relocateExternalSqlPathWithinFolder(path, previous, nextPath) ?? path) : normalizeExternalSqlPath(nextPath);
  };
  const result: SqlFileOrder = Object.create(null);
  for (const [parent, paths] of Object.entries(order)) {
    const nextParent = directory ? mapPath(parent) : parent;
    if (nextParent === null) continue;
    const nextPaths = paths.map(mapPath).filter((path): path is string => path !== null);
    if (nextPaths.length) result[nextParent] = [...new Set([...(result[nextParent] ?? []), ...nextPaths])];
  }
  return changed ? result : order;
}
