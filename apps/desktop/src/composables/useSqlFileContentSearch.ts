import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import type { SqlFileContentMatch, SqlFileEntry } from "@/lib/backend/api";
import { contentMatchPathSet, searchSqlFileContents, type SqlFileContentSearchResult } from "@/lib/sql/sqlFileContentSearch";
import { getSqlFileFilter } from "@/lib/sqlFile/sqlFileFolders";

interface SearchFolder {
  path: string;
  entries: SqlFileEntry[];
  loading: boolean;
  refreshing: boolean;
}

interface SearchRequest {
  generation: number;
  roots: string[];
  query: string;
  fileFilter: string;
}

/** Keep disk reads off the render path and serialize scans while typing. */
export function useSqlFileContentSearch(getQuery: () => string, getFolders: () => SearchFolder[], getInputPending: () => boolean = () => false) {
  const result = shallowRef<SqlFileContentSearchResult | null>(null);
  const searching = ref(false);
  const error = ref("");
  let generation = 0;
  let disposed = false;
  let running = false;
  let pending: SearchRequest | null = null;
  let resultQuery = "";
  let resultFileFilter = "";

  async function runPending() {
    if (disposed || running || !pending) return;
    const request = pending;
    pending = null;
    running = true;
    try {
      const response = await searchSqlFileContents(request);
      if (!disposed && request.generation === generation) {
        resultQuery = request.query;
        resultFileFilter = request.fileFilter;
        result.value = response;
      }
    } catch (cause) {
      if (!disposed && request.generation === generation) error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      running = false;
      if (!disposed && request.generation === generation) searching.value = false;
      // Only the latest committed request survives a slow filesystem scan.
      void runPending();
    }
  }

  watch(
    () => ({
      query: getQuery(),
      inputPending: getInputPending(),
      // Track entry replacement and refresh state, not expansion/selection.
      folders: getFolders().map((folder) => ({ path: folder.path, entries: folder.entries, loading: folder.loading, refreshing: folder.refreshing })),
    }),
    ({ query, folders, inputPending }) => {
      const current = ++generation;
      pending = null;
      const fileFilter = getSqlFileFilter();
      // Refresh in place: removing content-only hits while rescanning shrinks
      // the scroll container and destroys its rows and expanded snippets.
      // A different query/filter must never display the previous search's hits.
      if (!query || query !== resultQuery || fileFilter !== resultFileFilter || folders.length === 0) result.value = null;
      error.value = "";
      searching.value = !inputPending && !!query && folders.length > 0;
      if (!searching.value || folders.some((folder) => folder.loading || folder.refreshing)) return;

      pending = { generation: current, roots: folders.map((folder) => folder.path), query, fileFilter };
      void runPending();
    },
    { immediate: true, flush: "sync" },
  );

  onBeforeUnmount(() => {
    disposed = true;
    generation++;
    pending = null;
  });

  const matchesByPath = computed(() => result.value?.matchesByPath ?? new Map<string, SqlFileContentMatch>());
  const matchingPaths = computed(() => contentMatchPathSet(result.value));
  const incomplete = computed(() => !!result.value && (result.value.truncated || result.value.skippedFiles.length > 0));
  const skippedCount = computed(() => result.value?.skippedFiles.length ?? 0);
  const skippedFiles = computed(() => result.value?.skippedFiles ?? []);
  const truncated = computed(() => result.value?.truncated ?? false);

  return { searching, error, matchesByPath, matchingPaths, incomplete, skippedCount, skippedFiles, truncated };
}
