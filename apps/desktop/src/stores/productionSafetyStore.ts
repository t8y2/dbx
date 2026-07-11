import { ref } from "vue";
import { defineStore } from "pinia";

export interface ProductionConfirmationRequest {
  sql: string;
  connectionName?: string;
  database?: string;
  productionDatabases?: string[];
  source?: string;
}

/**
 * Coordinates the single production-write confirmation dialog shared by all
 * workbench surfaces. The request is intentionally transient and is never
 * persisted, so every production write requires a fresh user decision.
 */
export const useProductionSafetyStore = defineStore("productionSafety", () => {
  const pending = ref<ProductionConfirmationRequest>();
  let resolvePending: ((confirmed: boolean) => void) | undefined;

  function requestConfirmation(request: ProductionConfirmationRequest): Promise<boolean> {
    // A second operation cannot replace the SQL the user is currently reviewing.
    if (pending.value) return Promise.resolve(false);

    pending.value = request;
    return new Promise<boolean>((resolve) => {
      resolvePending = resolve;
    });
  }

  function settle(confirmed: boolean) {
    const resolve = resolvePending;
    resolvePending = undefined;
    pending.value = undefined;
    resolve?.(confirmed);
  }

  function confirm() {
    settle(true);
  }

  function cancel() {
    settle(false);
  }

  return { pending, requestConfirmation, confirm, cancel };
});
