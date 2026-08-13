import { computed, reactive, ref, type ComputedRef, type Ref } from "vue";
import type { MultiDbExecutionTarget, MultiDbExecutionItemStatus, MultiDbTargetExecutionResult } from "@/types/sqlExecution";

export interface MultiDbExecutionItem {
  id: string;
  target: Readonly<MultiDbExecutionTarget>;
  status: MultiDbExecutionItemStatus;
  errorMessage?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
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
}

export type MultiDbExecutionContextOverrides = Pick<MultiDbExecutionContext, "sourceOffset">;

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

  async function executeBatch(current: MultiDbExecutionBatch): Promise<void> {
    if (current.mode === "parallel") {
      await Promise.all(current.items.map((item) => executeItem(current, item)));
    } else {
      for (const item of current.items) {
        await executeItem(current, item);
        if (current.cancelRequested) break;
      }
    }

    if (current.cancelRequested) markPendingNotExecuted();
    current.status = current.cancelRequested ? "cancelled" : "completed";
    current.completedAt = Date.now();
    current.durationMs = current.completedAt - current.startedAt;
  }

  async function start(sql: string, targets: readonly MultiDbExecutionTarget[], context: MultiDbExecutionContextOverrides = {}, mode: MultiDbExecutionMode = "serial"): Promise<MultiDbExecutionBatch | undefined> {
    if (isRunning.value || !sql.trim() || targets.length === 0) return undefined;
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
    await executeBatch(current);
    return current;
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
    if (isRunning.value) return;
    batch.value = undefined;
  }

  return {
    batch,
    isRunning,
    start,
    cancel,
    reset,
  };
}
