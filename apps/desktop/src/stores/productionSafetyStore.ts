import { ref } from "vue";
import { defineStore } from "pinia";

export interface ProductionConfirmationRequest {
  sql: string;
  connectionName?: string;
  database?: string;
  productionDatabases?: string[];
  source?: string;
  /** Identifies a cancellable execution batch without coupling this store to its orchestrator. */
  scopeId?: string;
}

interface QueuedConfirmationRequest {
  request: ProductionConfirmationRequest;
  resolve: (confirmed: boolean) => void;
}

/**
 * Coordinates the single production-write confirmation dialog shared by all
 * workbench surfaces. The request is intentionally transient and is never
 * persisted, so every production write requires a fresh user decision.
 */
export const useProductionSafetyStore = defineStore("productionSafety", () => {
  const pending = ref<ProductionConfirmationRequest>();
  const queue: QueuedConfirmationRequest[] = [];
  let resolvePending: ((confirmed: boolean) => void) | undefined;

  function requestConfirmation(request: ProductionConfirmationRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (pending.value) {
        // Keep concurrent production writes visible instead of silently denying
        // the later operation while the user is reviewing the current SQL.
        queue.push({ request, resolve });
        return;
      }
      beginRequest(request, resolve);
    });
  }

  function beginRequest(request: ProductionConfirmationRequest, resolve: (confirmed: boolean) => void) {
    pending.value = request;
    resolvePending = resolve;
  }

  function settle(confirmed: boolean) {
    const resolve = resolvePending;
    resolvePending = undefined;
    pending.value = undefined;
    resolve?.(confirmed);

    const next = queue.shift();
    if (next) beginRequest(next.request, next.resolve);
  }

  function confirm() {
    settle(true);
  }

  function cancel() {
    settle(false);
  }

  function cancelScope(scopeId: string) {
    // Remove queued requests before settling the active one. `settle` promotes
    // the next queue entry, so removing afterwards could promote a request from
    // this same scope and leave its promise unresolved.
    const retained: QueuedConfirmationRequest[] = [];
    const cancelled: QueuedConfirmationRequest[] = [];
    for (const entry of queue) {
      (entry.request.scopeId === scopeId ? cancelled : retained).push(entry);
    }
    queue.splice(0, queue.length, ...retained);
    cancelled.forEach((entry) => entry.resolve(false));
    if (pending.value?.scopeId === scopeId) settle(false);
  }

  return { pending, requestConfirmation, confirm, cancel, cancelScope };
});
