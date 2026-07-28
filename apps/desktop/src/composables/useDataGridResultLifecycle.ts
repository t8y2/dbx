import { onUnmounted, watch, type Ref } from "vue";
import type { DataGridRuntimeScope } from "@/lib/dataGrid/dataGridRuntime";

export interface UseDataGridResultLifecycleOptions {
  resultKey: Ref<unknown>;
  runtimeScope?: DataGridRuntimeScope;
}

export function useDataGridResultLifecycle(options: UseDataGridResultLifecycleOptions) {
  let version = 0;
  let disposed = false;

  const invalidate = () => {
    version += 1;
  };

  const stopWatchingResult = watch(options.resultKey, invalidate);
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    invalidate();
    stopWatchingResult();
  };

  if (options.runtimeScope) options.runtimeScope.addCleanup(cleanup);
  else onUnmounted(cleanup);

  return {
    beginOperation() {
      return version;
    },
    isCurrent(operationVersion: number) {
      return !disposed && operationVersion === version;
    },
    invalidate,
    cleanup,
  };
}
