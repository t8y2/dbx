import { computed, reactive, ref, type ComputedRef, type Ref } from "vue";
import type { MultiDbExecutionTarget, MultiDbExecutionItemStatus, MultiDbTargetExecutionResult, MultiDbManualTransaction } from "@/types/sqlExecution";
import type { QueryResult } from "@/types/database";

export interface MultiDbExecutionItem {
  id: string;
  target: Readonly<MultiDbExecutionTarget>;
  status: MultiDbExecutionItemStatus;
  errorMessage?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  transaction?: MultiDbManualTransaction;
  settling?: boolean;
  /** Result produced by this target, kept for the merged multi-source view. */
  result?: QueryResult;
}

export interface MultiDbExecutionBatch {
  id: string;
  sourceTabId: string;
  sql: string;
  items: MultiDbExecutionItem[];
  status: "running" | "cancelling" | "completed" | "cancelled";
  cancelRequested: boolean;
  context: MultiDbExecutionContext;
  mode: "serial" | "parallel";
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
}

export interface MultiDbExecutionAdapter {
  executeTarget: (input: { target: MultiDbExecutionTarget; sourceTabId: string; sql: string; scopeId: string; context: Readonly<MultiDbExecutionContext>; isCancellationRequested: () => boolean }) => Promise<MultiDbTargetExecutionResult>;
  validateTarget?: (target: MultiDbExecutionTarget) => Promise<{ valid: boolean; errorMessage?: string }>;
  cancelTarget?: (sourceTabId: string, scopeId: string) => Promise<void>;
  cancelPending?: (scopeId: string) => void | Promise<void>;
}

export interface MultiDbExecutionContext {
  readonly batchId: string;
  readonly sourceTabId: string;
  readonly sql: string;
  readonly targets: readonly MultiDbExecutionTarget[];
  /** Offset of the submitted SQL in the source editor, captured at confirmation time. */
  readonly sourceOffset?: number;
  readonly manualTransaction?: boolean;
}

export type MultiDbExecutionContextOverrides = Pick<MultiDbExecutionContext, "sourceOffset" | "manualTransaction">;

export interface MultiDbExecutionOptions {
  sourceTabId: Ref<string> | ComputedRef<string> | string;
}

export type MultiDbExecutionMode = "serial" | "parallel";

function executionId(): string {
  return `multi-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}

export function useMultiDbExecution(adapter: MultiDbExecutionAdapter, options: MultiDbExecutionOptions) {
  const batch = ref<MultiDbExecutionBatch>();
  const isRunning = computed(() => batch.value?.status === "running" || batch.value?.status === "cancelling");
  const hasTransactions = computed(() => batch.value?.items.some((item) => !!item.transaction) === true);
  let activeRun: Promise<void> | undefined;
  let disposed = false;
  const settlements = new Set<Promise<unknown>>();

  async function finishTransaction(itemId: string, action: "commit" | "rollback"): Promise<boolean> {
    const item = batch.value?.items.find((candidate) => candidate.id === itemId);
    if (!item?.transaction || item.settling || (action === "commit" && (!item.transaction.canCommit || disposed || isRunning.value))) return false;
    item.settling = true;
    let settled!: () => void;
    const pending = new Promise<void>((resolve) => {
      settled = resolve;
    });
    settlements.add(pending);
    try {
      const warning = await item.transaction.finish(action);
      item.transaction = undefined;
      if (warning) {
        item.status = "failed";
        item.errorMessage = warning;
        return false;
      }
      item.status = action === "commit" ? "success" : "rolled_back";
      item.errorMessage = undefined;
      return true;
    } catch (error) {
      item.errorMessage = normalizeError(error);
      return false;
    } finally {
      item.settling = false;
      settlements.delete(pending);
      settled();
    }
  }

  async function rollbackPending(): Promise<boolean> {
    const items = batch.value?.items ?? [];
    const results = await Promise.all(items.filter((item) => item.transaction).map((item) => finishTransaction(item.id, "rollback")));
    return results.every(Boolean) && !hasTransactions.value;
  }

  function sourceTabId(): string {
    return typeof options.sourceTabId === "string" ? options.sourceTabId : options.sourceTabId.value;
  }

  function markPendingNotExecuted(): void {
    const current = batch.value;
    if (!current) return;
    for (const item of current.items) {
      if (item.status === "pending") {
        item.status = "not_executed";
        item.completedAt ??= Date.now();
        item.durationMs ??= 0;
      }
    }
  }

  async function executeItem(current: MultiDbExecutionBatch, item: MultiDbExecutionItem): Promise<void> {
    if (current.cancelRequested) {
      markPendingNotExecuted();
      return;
    }

    item.status = "running";
    item.startedAt = Date.now();
    try {
      if (adapter.validateTarget) {
        const validation = await adapter.validateTarget(item.target);
        if (!validation.valid) {
          item.status = current.cancelRequested ? "cancelled" : "failed";
          item.errorMessage = validation.errorMessage;
          item.completedAt = Date.now();
          item.durationMs = item.completedAt - (item.startedAt ?? item.completedAt);
          return;
        }
      }
      if (current.cancelRequested) {
        item.status = "cancelled";
        markPendingNotExecuted();
        item.completedAt = Date.now();
        item.durationMs = item.completedAt - (item.startedAt ?? item.completedAt);
        return;
      }
      const result = await adapter.executeTarget({
        target: item.target,
        sourceTabId: current.sourceTabId,
        sql: current.sql,
        scopeId: current.id,
        context: current.context,
        isCancellationRequested: () => current.cancelRequested,
      });
      item.status = current.cancelRequested && result.status === "failed" ? "cancelled" : result.status;
      item.errorMessage = result.errorMessage;
      item.durationMs = result.durationMs;
      item.result = result.result;
      item.transaction = result.transaction;
    } catch (error) {
      // One target is intentionally isolated from the queue. Adapter errors
      // become target failures so later targets keep running.
      item.status = current.cancelRequested ? "cancelled" : "failed";
      item.errorMessage = normalizeError(error);
    } finally {
      item.completedAt = Date.now();
      item.durationMs ??= item.completedAt - (item.startedAt ?? item.completedAt);
    }
  }

  async function executeBatch(current: MultiDbExecutionBatch, items = current.items): Promise<void> {
    if (current.mode === "parallel") {
      await Promise.all(items.map((item) => executeItem(current, item)));
    } else {
      for (const item of items) {
        await executeItem(current, item);
        if (current.cancelRequested) break;
      }
    }

    if (current.cancelRequested) {
      markPendingNotExecuted();
      await rollbackPending();
    }
    current.status = current.cancelRequested ? "cancelled" : "completed";
    current.completedAt = Date.now();
    current.durationMs = current.completedAt - current.startedAt;
  }

  async function runBatch(current: MultiDbExecutionBatch, items = current.items): Promise<void> {
    activeRun = executeBatch(current, items);
    try {
      await activeRun;
    } finally {
      activeRun = undefined;
    }
  }

  async function start(sql: string, targets: readonly MultiDbExecutionTarget[], context: MultiDbExecutionContextOverrides = {}, mode: MultiDbExecutionMode = "serial"): Promise<MultiDbExecutionBatch | undefined> {
    if (disposed || activeRun || isRunning.value || hasTransactions.value || !sql.trim() || targets.length === 0) return undefined;
    const sourceId = sourceTabId();
    const id = executionId();
    const targetSnapshot = targets.map((target) => Object.freeze({ ...target }));
    const current = reactive<MultiDbExecutionBatch>({
      id,
      sourceTabId: sourceId,
      sql,
      items: targetSnapshot.map((target, index) => ({
        id: `${index}-${executionId()}`,
        target: Object.freeze({ ...target }),
        status: "pending",
      })),
      status: "running",
      cancelRequested: false,
      mode,
      context: Object.freeze({
        batchId: id,
        sourceTabId: sourceId,
        sql,
        targets: Object.freeze(targetSnapshot),
        ...context,
      }),
      startedAt: Date.now(),
    });
    batch.value = current;
    await runBatch(current);
    return current;
  }

  async function retry(itemId: string): Promise<void> {
    const current = batch.value;
    const item = current?.items.find((candidate) => candidate.id === itemId);
    if (disposed || activeRun || isRunning.value || !current || !item || item.transaction || item.settling || !["failed", "cancelled", "not_executed", "skipped", "rolled_back"].includes(item.status)) return;
    current.status = "running";
    current.cancelRequested = false;
    current.completedAt = undefined;
    current.durationMs = undefined;
    item.errorMessage = undefined;
    item.completedAt = undefined;
    item.durationMs = undefined;
    item.result = undefined;
    await runBatch(current, [item]);
  }

  async function cancel(): Promise<void> {
    const current = batch.value;
    if (!current || current.status !== "running") return;
    current.cancelRequested = true;
    current.status = "cancelling";
    try {
      await adapter.cancelPending?.(current.id);
    } catch {
      // Cancellation is best-effort. Continue to the active target even when
      // a confirmation store has already settled concurrently.
    }
    const running = current.items.find((item) => item.status === "running");
    if (running && adapter.cancelTarget) {
      try {
        await adapter.cancelTarget(current.sourceTabId, current.id);
      } catch {
        // The target execution will settle the batch when its request returns.
      }
    }
    if (!running) {
      markPendingNotExecuted();
      current.status = "cancelled";
      current.completedAt = Date.now();
      current.durationMs = current.completedAt - current.startedAt;
    }
  }

  function reset(): void {
    if (activeRun || isRunning.value || hasTransactions.value) return;
    batch.value = undefined;
  }

  async function cancelAndRollback(): Promise<boolean> {
    await cancel();
    await activeRun;
    await Promise.all(settlements);
    return rollbackPending();
  }

  async function dispose(): Promise<boolean> {
    disposed = true;
    return cancelAndRollback();
  }

  return {
    batch,
    isRunning,
    hasTransactions,
    finishTransaction,
    rollbackPending,
    dispose,
    cancelAndRollback,
    start,
    retry,
    cancel,
    reset,
  };
}
