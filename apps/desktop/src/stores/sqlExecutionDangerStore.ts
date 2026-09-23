import { defineStore } from "pinia";
import { ref } from "vue";
import type { DatabaseType } from "@/types/database";

export interface SqlExecutionDangerRequest {
  sql: string;
  kind: "sql" | "redis";
  connectionName?: string;
  database?: string;
  targetLabel?: string;
  /**
   * Every data source the pending batch will touch. Shown in the confirmation
   * so the operator confirms the whole fan-out, not just the target that
   * happened to reach the prompt first.
   */
  targets?: string[];
  databaseType?: DatabaseType;
  /** Identifies a cancellable execution batch without coupling this store to its orchestrator. */
  scopeId?: string;
}

interface QueuedDangerRequest {
  request: SqlExecutionDangerRequest;
  resolve: (confirmed: boolean) => void;
}

/**
 * A batch asks once per target, but the operator answers once per batch: the
 * decision is remembered per `scopeId` so the remaining targets reuse it
 * instead of re-prompting (and re-asking for the confirmation code).
 */
const MAX_REMEMBERED_SCOPES = 50;

export const useSqlExecutionDangerStore = defineStore("sqlExecutionDanger", () => {
  const pending = ref<SqlExecutionDangerRequest>();
  const queue: QueuedDangerRequest[] = [];
  const scopeOutcome = new Map<string, boolean>();
  let resolvePending: ((confirmed: boolean) => void) | undefined;

  function rememberScopeOutcome(scopeId: string | undefined, confirmed: boolean): void {
    if (!scopeId) return;
    scopeOutcome.delete(scopeId);
    scopeOutcome.set(scopeId, confirmed);
    while (scopeOutcome.size > MAX_REMEMBERED_SCOPES) {
      const oldest = scopeOutcome.keys().next().value;
      if (oldest === undefined) break;
      scopeOutcome.delete(oldest);
    }
  }

  function rememberedOutcome(request: SqlExecutionDangerRequest): boolean | undefined {
    return request.scopeId ? scopeOutcome.get(request.scopeId) : undefined;
  }

  function requestConfirmation(request: SqlExecutionDangerRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const remembered = rememberedOutcome(request);
      if (remembered !== undefined) {
        resolve(remembered);
        return;
      }
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

  /** Promotes queued requests, resolving the ones whose batch is already decided. */
  function promoteNext(): void {
    while (queue.length > 0) {
      const next = queue.shift()!;
      const remembered = rememberedOutcome(next.request);
      if (remembered !== undefined) {
        next.resolve(remembered);
        continue;
      }
      begin(next.request, next.resolve);
      return;
    }
  }

  function settle(confirmed: boolean): void {
    const request = pending.value;
    const resolve = resolvePending;
    resolvePending = undefined;
    pending.value = undefined;
    rememberScopeOutcome(request?.scopeId, confirmed);
    resolve?.(confirmed);
    promoteNext();
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
    // A cancelled batch must prompt again if the same scope id is ever reused.
    scopeOutcome.delete(scopeId);
  }

  return { pending, requestConfirmation, confirm, cancel, cancelAll, cancelScope };
});
