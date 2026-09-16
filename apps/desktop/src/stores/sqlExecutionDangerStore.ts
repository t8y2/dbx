import { defineStore } from "pinia";
import { ref } from "vue";
import type { DatabaseType } from "@/types/database";

export interface SqlExecutionDangerRequest {
  sql: string;
  kind: "sql" | "redis";
  connectionName?: string;
  database?: string;
  targetLabel?: string;
  databaseType?: DatabaseType;
  /** Identifies a cancellable execution batch without coupling this store to its orchestrator. */
  scopeId?: string;
}

interface QueuedDangerRequest {
  request: SqlExecutionDangerRequest;
  resolve: (confirmed: boolean) => void;
}

export const useSqlExecutionDangerStore = defineStore("sqlExecutionDanger", () => {
  const pending = ref<SqlExecutionDangerRequest>();
  const queue: QueuedDangerRequest[] = [];
  let resolvePending: ((confirmed: boolean) => void) | undefined;

  function requestConfirmation(request: SqlExecutionDangerRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (pending.value) {
        queue.push({ request, resolve });
        return;
      }
      begin(request, resolve);
    });
  }

  function begin(request: SqlExecutionDangerRequest, resolve: (confirmed: boolean) => void): void {
    pending.value = request;
    resolvePending = resolve;
  }

  function settle(confirmed: boolean): void {
    const resolve = resolvePending;
    resolvePending = undefined;
    pending.value = undefined;
    resolve?.(confirmed);
    const next = queue.shift();
    if (next) begin(next.request, next.resolve);
  }

  function confirm(): void {
    settle(true);
  }

  function cancel(): void {
    settle(false);
  }

  function cancelAll(): void {
    settle(false);
    while (queue.length > 0) queue.shift()?.resolve(false);
  }

  function cancelScope(scopeId: string): void {
    // Remove queued requests before settling the active one. `settle` promotes
    // the next queue entry, so removing afterwards could promote a request from
    // this same scope and leave its promise unresolved.
    const retained: QueuedDangerRequest[] = [];
    const cancelled: QueuedDangerRequest[] = [];
    for (const entry of queue) {
      (entry.request.scopeId === scopeId ? cancelled : retained).push(entry);
    }
    queue.splice(0, queue.length, ...retained);
    cancelled.forEach((entry) => entry.resolve(false));
    if (pending.value?.scopeId === scopeId) settle(false);
  }

  return { pending, requestConfirmation, confirm, cancel, cancelAll, cancelScope };
});
