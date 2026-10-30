import { computed, ref } from "vue";
import * as api from "@/lib/backend/api";
import type { TaskRun, TaskRunCursor, TaskRunListQuery } from "@/lib/backend/tauri";

export function useTaskRunHistory(pageSize = 30) {
  const runs = ref<TaskRun[]>([]);
  const loading = ref(false);
  const loadingMore = ref(false);
  const failed = ref(false);
  const nextCursor = ref<TaskRunCursor | null>(null);
  const hasMore = computed(() => nextCursor.value !== null);

  let requestVersion = 0;
  let lastQuery: TaskRunListQuery = {};

  async function loadFirstPage(query: TaskRunListQuery = {}): Promise<void> {
    const version = ++requestVersion;
    lastQuery = { ...query, limit: query.limit ?? pageSize, cursor: undefined };
    runs.value = [];
    nextCursor.value = null;
    failed.value = false;
    loading.value = true;
    loadingMore.value = false;

    try {
      const page = await api.loadTaskRuns(lastQuery);
      if (version !== requestVersion) return;
      runs.value = page.items;
      nextCursor.value = page.nextCursor ?? null;
    } catch {
      if (version === requestVersion) failed.value = true;
    } finally {
      if (version === requestVersion) loading.value = false;
    }
  }

  async function retry(): Promise<void> {
    await loadFirstPage(lastQuery);
  }

  async function loadMore(): Promise<void> {
    const cursor = nextCursor.value;
    if (!cursor || loading.value || loadingMore.value) return;
    const version = requestVersion;
    loadingMore.value = true;
    failed.value = false;

    try {
      const page = await api.loadTaskRuns({ ...lastQuery, cursor });
      if (version !== requestVersion) return;
      const knownRunIds = new Set(runs.value.map((run) => run.runId));
      runs.value = [...runs.value, ...page.items.filter((run) => !knownRunIds.has(run.runId))];
      nextCursor.value = page.nextCursor ?? null;
    } catch {
      if (version === requestVersion) failed.value = true;
    } finally {
      if (version === requestVersion) loadingMore.value = false;
    }
  }

  function invalidate(): void {
    requestVersion += 1;
    runs.value = [];
    nextCursor.value = null;
    loading.value = false;
    loadingMore.value = false;
    failed.value = false;
  }

  return { runs, loading, loadingMore, failed, nextCursor, hasMore, loadFirstPage, loadMore, retry, invalidate };
}
