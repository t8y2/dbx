import { onScopeDispose, ref, shallowRef, watch, type Ref, type WatchSource } from "vue";
import { removeVerifiedSidebarTriggerSearchResult, type SidebarRemoteSearchResult } from "@/lib/sidebar/sidebarRemoteSearch";
import type { TreeNode } from "@/types/database";

export function useSidebarRemoteSearch(options: {
  query: Ref<string>;
  enabled: Readonly<Ref<boolean>>;
  context: WatchSource[];
  load: (query: string, signal: AbortSignal, onProgress: (results: SidebarRemoteSearchResult[]) => void) => Promise<SidebarRemoteSearchResult[]>;
  onError: (error: unknown) => void;
}) {
  const results = shallowRef<SidebarRemoteSearchResult[]>([]);
  const isLoading = ref(false);
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortPending = () => {
    clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
    isLoading.value = false;
  };
  const reset = () => {
    abortPending();
    results.value = [];
  };
  const scopeKey = (result: SidebarRemoteSearchResult) => JSON.stringify([result.parentNodeId, result.connectionId, result.database, result.schema ?? null, result.catalog ?? null, result.nodeType]);
  const mergeProgress = (loaded: SidebarRemoteSearchResult[]) => {
    const merged = new Map(results.value.map((result) => [scopeKey(result), result]));
    for (const result of loaded) merged.set(scopeKey(result), result);
    results.value = [...merged.values()];
  };
  const schedule = () => {
    const query = options.query.value.trim().toLowerCase();
    if (!query || !options.enabled.value) {
      results.value = [];
      return;
    }
    const request = new AbortController();
    controller = request;
    timer = setTimeout(() => {
      timer = undefined;
      isLoading.value = true;
      void options
        .load(query, request.signal, (loaded) => {
          if (!request.signal.aborted) mergeProgress(loaded);
        })
        .then((loaded) => {
          // A scope that failed to refresh is absent from `loaded`; retain its
          // previous snapshot. Successful empty scopes are still published as
          // explicit results with `children: []`, so they replace stale hits.
          if (!request.signal.aborted) mergeProgress(loaded);
        })
        .catch((error) => {
          if (!request.signal.aborted) options.onError(error);
        })
        .finally(() => {
          if (controller !== request) return;
          controller = undefined;
          if (!request.signal.aborted) isLoading.value = false;
        });
    }, 300);
  };

  watch(
    options.query,
    () => {
      // Keep the last completed projection visible while its replacement is
      // debounced/loaded. The normal tree filter applies the new query to that
      // snapshot, so overlapping matches stay stable instead of disappearing
      // and reappearing when remote-only object types refresh.
      abortPending();
      schedule();
    },
    { flush: "sync" },
  );

  watch(
    [options.enabled, ...options.context],
    () => {
      // Context boundaries can point at a different connection, database, or
      // object layout. Never retain a projection across those boundaries.
      reset();
      schedule();
    },
    { flush: "sync" },
  );

  onScopeDispose(reset);
  const removeVerifiedTriggerNode = (node: TreeNode) => {
    abortPending();
    results.value = removeVerifiedSidebarTriggerSearchResult(results.value, node);
    schedule();
  };
  return { results, isLoading, removeVerifiedTriggerNode };
}
