import * as api from "@/lib/backend/api";
import type { SqlFileContentMatch, SqlFileContentSearchResult as BackendSearchResult } from "@/lib/backend/api";
import { normalizeExternalSqlPath } from "@/lib/sql/sqlFileOpen";

export interface SqlFileContentSearchResult extends BackendSearchResult {
  matchesByPath: Map<string, SqlFileContentMatch>;
}

export interface SearchSqlFileContentsOptions {
  roots: string[];
  query: string;
  /** Use the same filter expression as the file tree, including extensionless files. */
  fileFilter: string;
}

/** The dedicated scanner owns decoding, per-line grouping, preview limits and skipped reasons. */
export async function searchSqlFileContents(options: SearchSqlFileContentsOptions): Promise<SqlFileContentSearchResult> {
  const query = options.query.trim();
  const roots = options.roots.filter((root) => root.trim().length > 0);
  if (!query || roots.length === 0) return { files: [], skippedFiles: [], truncated: false, matchesByPath: new Map() };

  const result = await api.searchSqlFileContents(roots, query, options.fileFilter);
  // Keep files with no remaining preview budget: they still matched and must be visible.
  return { ...result, matchesByPath: new Map(result.files.map((file) => [normalizeExternalSqlPath(file.path), file])) };
}

export function contentMatchPathSet(result: SqlFileContentSearchResult | null | undefined): ReadonlySet<string> {
  return new Set(result?.matchesByPath.keys() ?? []);
}
