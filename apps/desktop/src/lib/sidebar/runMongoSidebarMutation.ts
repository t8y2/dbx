import type { Ref } from "vue";
import type { ConnectionConfig } from "@/types/database";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";

export type RunMongoSidebarMutationOptions<T> = {
  connection?: ConnectionConfig;
  database: string;
  reviewText: string;
  source: string;
  loading: Ref<boolean>;
  /** Runs after production confirmation and after loading is set (e.g. ensureConnected). */
  beforeExecute?: () => Promise<void>;
  execute: () => Promise<T>;
  onSuccess: (result: T) => void;
  onError?: (error: unknown) => void;
};

/**
 * Shared production-gated mutation shell for Mongo sidebar writes.
 * Production confirmation runs before loading so cancel never shows a busy state.
 *
 * Success is boxed as `{ result }` so void executes are not confused with cancel
 * (`executeWithProductionContextGuard` returns `undefined` only when cancelled).
 */
export async function runMongoSidebarMutation<T>(options: RunMongoSidebarMutationOptions<T>): Promise<void> {
  if (options.loading.value) return;
  try {
    const executed = await executeWithProductionContextGuard({
      connection: options.connection,
      database: options.database,
      reviewText: options.reviewText,
      source: options.source,
      execute: async () => {
        options.loading.value = true;
        if (options.beforeExecute) {
          await options.beforeExecute();
        }
        const result = await options.execute();
        return { result };
      },
    });
    // Cancel only: guard returns undefined when the user declines production confirmation.
    if (executed === undefined) return;
    options.onSuccess(executed.result);
  } catch (error: unknown) {
    options.onError?.(error);
  } finally {
    options.loading.value = false;
  }
}
