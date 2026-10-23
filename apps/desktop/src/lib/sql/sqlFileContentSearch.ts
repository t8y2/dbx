import * as api from "@/lib/backend/api";
import type { GlobalSearchMatch } from "@/lib/backend/api";
import { formatSnippetLine, splitSearchMatchSegments, type SavedSqlLineMatch } from "@/lib/savedSql/savedSqlSearch";
import { normalizeExternalSqlPath } from "@/lib/sql/sqlFileOpen";

/** Matches the Quick Open content-mode debounce so typing feels the same in both surfaces. */
export const SQL_FILE_CONTENT_SEARCH_DEBOUNCE_MS = 250;
/** Upper bound on backend hits; keeps a broad query from returning megabytes of snippets. */
export const SQL_FILE_CONTENT_SEARCH_RESULT_LIMIT = 500;
/**
 * Upper bound on snippets kept per file. Mirrors the SQL library's expanded cap
 * (`EXPANDED_MATCHES` in SqlLibrarySearchSnippet.vue) so both lists scroll the
 * same amount; `totalMatches` still reports every distinct matching line, so the
 * "+N more" label stays honest.
 */
export const SQL_FILE_SNIPPET_MAX_MATCHES = 100;
/** Long lines are truncated around the first match, same as the SQL library list. */
const SNIPPET_MAX_LINE_LENGTH = 100;

export interface SqlFileContentMatchGroup {
  path: string;
  matches: SavedSqlLineMatch[];
  /** Total hit lines for this file. A line that matches several times counts once. */
  totalMatches: number;
}

export interface SqlFileContentSearchResult {
  matchesByPath: Map<string, SqlFileContentMatchGroup>;
}

export interface SearchSqlFileContentsOptions {
  roots: string[];
  query: string;
  /** Extensions without the leading dot, e.g. `["sql", "ddl"]`. */
  extensions?: string[];
  limit?: number;
  /**
   * Max traversal depth in `WalkBuilder` terms (root = 0, its entries = 1).
   * Callers that render results from a bounded tree pass the tree's own depth so
   * the walk cannot produce hits they are unable to display.
   */
  maxDepth?: number;
}

interface MutableGroup {
  path: string;
  matches: SavedSqlLineMatch[];
  /** One snippet per line, keyed by line number. */
  byLine: Map<number, SavedSqlLineMatch>;
  totalMatches: number;
}

/**
 * Turns raw backend hits into per-file snippet groups for the SQL file tree.
 *
 * A file can produce several hits for the same line (the backend reports every
 * occurrence), but the tree shows one snippet per line — the leftmost one,
 * because that is the occurrence the snippet text is built around. The backend
 * normally reports hits in reading order; comparing columns keeps this
 * deterministic instead of relying on that.
 * `line === 0` is the backend's filename-match sentinel; the tree already
 * matches on names locally, so those hits are not content.
 */
function groupMatches(matches: GlobalSearchMatch[], query: string, limit: number): SqlFileContentSearchResult {
  const trimmedQuery = query.trim();
  const matchesByPath = new Map<string, SqlFileContentMatchGroup>();
  if (!trimmedQuery) return { matchesByPath };

  const groups = new Map<string, MutableGroup>();
  for (const match of matches) {
    if (match.line <= 0) continue;
    const path = normalizeExternalSqlPath(match.path);
    if (!path) continue;
    let group = groups.get(path);
    if (!group) {
      group = { path, matches: [], byLine: new Map<number, SavedSqlLineMatch>(), totalMatches: 0 };
      groups.set(path, group);
    }
    const existing = group.byLine.get(match.line);
    if (existing && existing.column <= match.column) continue;
    const lineText = formatSnippetLine(match.lineText, trimmedQuery, SNIPPET_MAX_LINE_LENGTH);
    const snippet: SavedSqlLineMatch = {
      lineNumber: match.line,
      column: match.column,
      lineText,
      segments: splitSearchMatchSegments(lineText, trimmedQuery),
    };
    if (!existing) group.totalMatches++;
    group.byLine.set(match.line, snippet);
  }

  // One file can hit the global backend limit on its own, so the per-file
  // snippet list is capped separately; `totalMatches` keeps the full count.
  const snippetLimit = Math.min(limit, SQL_FILE_SNIPPET_MAX_MATCHES);
  for (const group of groups.values()) {
    group.matches = [...group.byLine.values()].sort((a, b) => a.lineNumber - b.lineNumber).slice(0, snippetLimit);
    matchesByPath.set(group.path, { path: group.path, matches: group.matches, totalMatches: group.totalMatches });
  }
  return { matchesByPath };
}

/**
 * Searches the given roots for `query` and groups the hits by file path.
 *
 * `respectIgnoreRules: false` makes the backend walk the same file set the SQL
 * file tree lists (raw `read_dir`: hidden files and `.gitignore`d files
 * included). Results are never cached here — the caller owns debouncing and
 * discarding stale generations.
 */
export async function searchSqlFileContents(options: SearchSqlFileContentsOptions): Promise<SqlFileContentSearchResult> {
  const query = options.query.trim();
  const roots = options.roots.filter((root) => root.trim().length > 0);
  if (!query || roots.length === 0) return { matchesByPath: new Map() };

  const limit = options.limit ?? SQL_FILE_CONTENT_SEARCH_RESULT_LIMIT;
  const extensions = options.extensions && options.extensions.length > 0 ? options.extensions : undefined;
  const matches = await api.globalSearch({
    roots,
    query,
    extensions,
    limit,
    respectIgnoreRules: false,
    maxDepth: options.maxDepth,
  });
  return groupMatches(matches, query, limit);
}

/** Normalized paths of every file with at least one content hit. */
export function contentMatchPathSet(result: SqlFileContentSearchResult | null | undefined): ReadonlySet<string> {
  return new Set(result?.matchesByPath.keys() ?? []);
}
