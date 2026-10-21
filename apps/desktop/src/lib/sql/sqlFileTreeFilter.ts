import type { SqlFileEntry } from "@/lib/backend/api";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

const SORT_ORDER_STORAGE_KEY = "dbx-sql-file-sort-order";
export type SqlFileSortOrder = "asc" | "desc";
export const DEFAULT_SQL_FILE_SORT_ORDER: SqlFileSortOrder = "asc";

/** Read the sort order ("asc" or "desc") for external SQL files. */
export function getSqlFileSortOrder(): SqlFileSortOrder {
  const order = safeLocalStorageGet(SORT_ORDER_STORAGE_KEY)?.trim();
  return order === "desc" ? "desc" : DEFAULT_SQL_FILE_SORT_ORDER;
}

/** Persist the sort order for external SQL files. */
export function saveSqlFileSortOrder(order: SqlFileSortOrder): void {
  safeLocalStorageSet(SORT_ORDER_STORAGE_KEY, order === "desc" ? "desc" : "asc");
}

export interface SqlFileFilterResult {
  entries: SqlFileEntry[];
  autoExpanded: Set<string>;
  matchCount: number;
}

/**
 * Compare two SqlFileEntry nodes for ordering.
 * Folders/directories always appear before files.
 * Within the same kind, names are compared naturally (e.g. file2 < file10).
 */
export function compareSqlFileEntries(a: SqlFileEntry, b: SqlFileEntry, order: SqlFileSortOrder = "asc"): number {
  if (a.is_dir !== b.is_dir) {
    return a.is_dir ? -1 : 1;
  }
  let cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  if (cmp === 0) {
    cmp = a.name.localeCompare(b.name);
  }
  return order === "desc" ? -cmp : cmp;
}

/**
 * Recursively sorts SQL file entries by name (folders first) in ascending or descending order.
 * Returns a new array and new entry objects for modified directories (immutable).
 */
export function recursivelySortSqlFileEntries(entries: SqlFileEntry[], order: SqlFileSortOrder = "asc"): SqlFileEntry[] {
  const sorted = [...entries].sort((a, b) => compareSqlFileEntries(a, b, order));
  return sorted.map((entry) => {
    if (entry.is_dir && entry.children && entry.children.length > 0) {
      return {
        ...entry,
        children: recursivelySortSqlFileEntries(entry.children, order),
      };
    }
    return entry;
  });
}

function collectMatchingDescendantDirPaths(items: SqlFileEntry[], q: string, autoExpanded: Set<string>) {
  for (const item of items) {
    if (item.is_dir) {
      if (item.name.toLowerCase().includes(q)) {
        autoExpanded.add(item.path);
      }
      if (item.children) {
        collectMatchingDescendantDirPaths(item.children, q, autoExpanded);
      }
    }
  }
}

/**
 * Filters and sorts SQL file entries based on a search query and sort order.
 * - If the query is empty, all entries are preserved and recursively sorted.
 * - If a directory's name matches the query, all of its contents are preserved (and recursively sorted),
 *   and its path is added to `autoExpanded`.
 * - If a directory's name does not match, but some descendants do, the directory is kept with only the matching descendants,
 *   and its path is added to `autoExpanded`.
 * - If a file matches the query, it is kept.
 */
export function filterAndSortSqlFileEntries(entries: SqlFileEntry[], query: string, order: SqlFileSortOrder = "asc"): SqlFileFilterResult {
  const trimmed = query.trim();
  if (!trimmed) {
    const sorted = recursivelySortSqlFileEntries(entries, order);
    let count = 0;
    const countNodes = (items: SqlFileEntry[]) => {
      for (const item of items) {
        count++;
        if (item.is_dir && item.children) countNodes(item.children);
      }
    };
    countNodes(sorted);
    return {
      entries: sorted,
      autoExpanded: new Set<string>(),
      matchCount: count,
    };
  }

  const q = trimmed.toLowerCase();
  const autoExpanded = new Set<string>();
  let matchCount = 0;

  function filterEntries(items: SqlFileEntry[]): SqlFileEntry[] {
    const result: SqlFileEntry[] = [];

    for (const item of items) {
      if (!item.is_dir) {
        if (item.name.toLowerCase().includes(q)) {
          matchCount++;
          result.push(item);
        }
      } else {
        const dirMatches = item.name.toLowerCase().includes(q);
        if (dirMatches) {
          matchCount++;
          autoExpanded.add(item.path);
          if (item.children && item.children.length > 0) {
            collectMatchingDescendantDirPaths(item.children, q, autoExpanded);
            result.push({
              ...item,
              children: recursivelySortSqlFileEntries(item.children, order),
            });
          } else {
            result.push(item);
          }
        } else {
          const filteredChildren = filterEntries(item.children || []);
          if (filteredChildren.length > 0) {
            autoExpanded.add(item.path);
            result.push({
              ...item,
              children: filteredChildren,
            });
          }
        }
      }
    }

    result.sort((a, b) => compareSqlFileEntries(a, b, order));
    return result;
  }

  const filtered = filterEntries(entries);
  return {
    entries: filtered,
    autoExpanded,
    matchCount,
  };
}
