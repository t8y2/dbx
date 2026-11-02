import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import * as api from "@/lib/backend/api";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import { nativeJobRefKey, type NativeJobOperationStatus, type NativeJobPreparedPlan, type NativeJobRef, type NativeJobRequest, type NativeJobScope } from "@/lib/database/nativeJobs";
import type { ConnectionConfig } from "@/types/database";

interface JobExecutionOptions {
  connection: () => ConnectionConfig;
  database: () => string;
  scope: () => NativeJobScope | undefined;
  selected: () => NativeJobRef | undefined;
  source: () => string;
  onFinished?: (status: NativeJobOperationStatus) => Promise<void> | void;
  onTargetObserved?: (status: NativeJobOperationStatus, originalTarget: NativeJobRef) => Promise<void> | void;
}

interface PreparedJob {
  plan: NativeJobPreparedPlan;
  identity: string;
  sourceIdentity: string;
  connection: ConnectionConfig;
  database: string;
}

interface JobExecution {
  prepared: PreparedJob;
  status: NativeJobOperationStatus;
  error: string;
  notified: boolean;
  callbackGeneration: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameScope(left: NativeJobScope, right: NativeJobScope | undefined): boolean {
  return !!right && left.connectionId === right.connectionId && left.database === right.database && left.contextId === right.contextId;
}

/** One management page's preview/confirmation/result lifecycle; native execution stays in Core. */
export function useNativeJobExecution(options: JobExecutionOptions) {
  const prepared = shallowRef<PreparedJob>();
  const execution = shallowRef<JobExecution>();
  const preparing = ref(false);
  const confirming = ref(false);
  const observing = ref(false);
  const error = ref("");
  const callbackGeneration = ref(0);
  let generation = 0;
  let refreshGeneration = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const sourceIdentity = computed(() => JSON.stringify([connectionConfigFingerprint(options.connection()), options.database(), options.scope()]));
  const identity = computed(() => JSON.stringify([sourceIdentity.value, options.selected() ? nativeJobRefKey(options.selected()!) : null]));
  const busy = computed(() => confirming.value || (!!execution.value && execution.value.status.state !== "finished"));
  const preview = computed(() => prepared.value?.plan);
  function isVisible(current: JobExecution) {
    return current.prepared.sourceIdentity === sourceIdentity.value && (current.prepared.identity === identity.value || (!!current.status.target && !!options.selected() && nativeJobRefKey(current.status.target) === nativeJobRefKey(options.selected()!)));
  }
  const visibleExecution = computed(() => (execution.value && isVisible(execution.value) ? execution.value : undefined));
  const previousExecution = computed(() => {
    const current = execution.value;
    return current && current.callbackGeneration !== callbackGeneration.value && connectionConfigFingerprint(current.prepared.connection) === connectionConfigFingerprint(options.connection()) && current.prepared.database === options.database() ? current : undefined;
  });

  function invalidatePreview() {
    generation += 1;
    prepared.value = undefined;
    preparing.value = false;
    error.value = "";
  }

  watch(identity, invalidatePreview, { flush: "sync" });

  async function prepare(request: NativeJobRequest) {
    const requestedScope = request.action === "create" ? request.scope : request.target.scope;
    if (!sameScope(requestedScope, options.scope())) throw new Error("native_job_context_changed");
    if (request.action !== "create" && (!options.selected() || nativeJobRefKey(request.target) !== nativeJobRefKey(options.selected()!))) throw new Error("native_job_identity_mismatch");
    const current = ++generation;
    const expectedIdentity = identity.value;
    const connection = { ...options.connection() };
    const database = options.database();
    prepared.value = undefined;
    preparing.value = true;
    error.value = "";
    try {
      const plan = await api.nativeJobPrepare(request);
      if (disposed || current !== generation || expectedIdentity !== identity.value) return;
      if (!sameScope(plan.scope, requestedScope) || (request.action !== "create" && (!plan.target || nativeJobRefKey(plan.target) !== nativeJobRefKey(request.target)))) throw new Error("native_job_identity_mismatch");
      prepared.value = { plan, identity: expectedIdentity, sourceIdentity: sourceIdentity.value, connection, database };
      return plan;
    } catch (failure) {
      if (!disposed && current === generation && expectedIdentity === identity.value) error.value = errorMessage(failure);
    } finally {
      if (current === generation) preparing.value = false;
    }
  }

  function schedulePoll(current: JobExecution) {
    if (disposed || execution.value !== current || current.status.state === "finished") return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void refreshExecution(current), 400);
  }

  async function acceptStatus(current: JobExecution, status: NativeJobOperationStatus) {
    if (disposed || execution.value !== current) return;
    if (status.operationId !== current.prepared.plan.operationId) throw new Error("native_job_identity_mismatch");
    current.status = status;
    current.error = "";
    execution.value = { ...current };
    // Keep this request's identity even if the page now displays another job.
    const updated = execution.value;
    if (status.state === "finished") {
      if (current.callbackGeneration === callbackGeneration.value && current.prepared.plan.target && isVisible(updated)) {
        await options.onTargetObserved?.(status, current.prepared.plan.target);
        if (disposed || execution.value !== updated) return;
      }
      if (updated.callbackGeneration === callbackGeneration.value && !updated.notified) {
        updated.notified = true;
        if (isVisible(updated)) await options.onFinished?.(status);
      }
    } else {
      schedulePoll(updated);
    }
  }

  async function refreshExecution(current = execution.value, observe = false) {
    if (!current || disposed || execution.value !== current) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    const requested = ++refreshGeneration;
    if (observe) observing.value = true;
    try {
      const status = observe ? await api.nativeJobStatus(current.prepared.plan.operationId, true) : await api.nativeJobStatus(current.prepared.plan.operationId);
      if (requested !== refreshGeneration) return;
      await acceptStatus(current, status);
    } catch (failure) {
      if (!disposed && requested === refreshGeneration && execution.value === current) execution.value = { ...current, error: errorMessage(failure) };
    } finally {
      if (requested === refreshGeneration) observing.value = false;
    }
  }

  async function apply() {
    const selected = prepared.value;
    if (!selected || busy.value) return;
    confirming.value = true;
    error.value = "";
    try {
      return await executeWithProductionContextGuard({
        connection: selected.connection,
        database: selected.database,
        reviewText: selected.plan.steps.map((step) => step.sql).join("\n\n"),
        source: options.source(),
        execute: async () => {
          if (disposed || prepared.value !== selected || identity.value !== selected.identity) throw new Error("native_job_context_changed");
          const plan = selected.plan;
          const current: JobExecution = {
            prepared: selected,
            status: { operationId: plan.operationId, target: plan.target, state: "running", outcome: "unknown", cancelRequested: false, steps: plan.steps.map((step) => ({ id: step.id, state: "pending", reason: null, vendorCode: null })), reason: "native_job_apply_receipt_unknown" },
            error: "",
            notified: false,
            callbackGeneration: callbackGeneration.value,
          };
          prepared.value = undefined;
          execution.value = current;
          schedulePoll(current);
          try {
            await acceptStatus(current, await api.nativeJobApply(plan.planId));
          } catch {
            // A missing apply receipt authorizes only status lookup, never another apply.
            await refreshExecution(current);
          }
          return execution.value?.status;
        },
      });
    } catch (failure) {
      if (!disposed && identity.value === selected.identity) error.value = errorMessage(failure);
    } finally {
      confirming.value = false;
    }
  }

  async function cancel() {
    const current = execution.value;
    if (!current || current.status.state === "finished") return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    try {
      await acceptStatus(current, await api.nativeJobCancel(current.prepared.plan.operationId));
    } catch (failure) {
      if (!disposed && execution.value === current) execution.value = { ...current, error: errorMessage(failure) };
    }
  }

  onScopeDispose(() => {
    disposed = true;
    generation += 1;
    if (timer) clearTimeout(timer);
    // Closing the page stops observation, not a native operation already dispatched.
  });

  function invalidateContext() {
    callbackGeneration.value++;
    invalidatePreview();
  }

  return { preview, execution: visibleExecution, previousExecution, preparing, confirming, observing, busy, error, prepare, apply, cancel, refresh: () => refreshExecution(), observe: () => refreshExecution(execution.value, true), invalidatePreview, invalidateContext };
}
