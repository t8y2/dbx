import { effectScope, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeJobMutation, NativeJobOperationStatus, NativeJobPreparedPlan, NativeJobRef, NativeJobScope } from "@/lib/database/nativeJobs";
import type { ConnectionConfig } from "@/types/database";

const rpc = vi.hoisted(() => ({ prepare: vi.fn(), apply: vi.fn(), status: vi.fn(), cancel: vi.fn(), guard: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ nativeJobPrepare: rpc.prepare, nativeJobApply: rpc.apply, nativeJobStatus: rpc.status, nativeJobCancel: rpc.cancel }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: rpc.guard }));

import { useNativeJobExecution } from "@/composables/useNativeJobExecution";

const scope: NativeJobScope = { connectionId: "c", database: "", contextId: "original" };
const target: NativeJobRef = { scope, kind: "scheduler", owner: "Owner", name: "A,B" };
const mutation: NativeJobMutation = { target, baseline: "revision", action: "run" };
const plan: NativeJobPreparedPlan = { scope, target, planId: "plan", operationId: "operation", steps: [{ id: "run", label: "Run", sql: "native reviewed SQL" }] };

function status(state: NativeJobOperationStatus["state"] = "finished", outcome: NativeJobOperationStatus["outcome"] = "accepted"): NativeJobOperationStatus {
  return { operationId: plan.operationId, target, state, outcome, cancelRequested: false, steps: [{ id: "run", state: "accepted", reason: null, vendorCode: null }], reason: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const scopes: ReturnType<typeof effectScope>[] = [];
function setup() {
  const connection = ref<ConnectionConfig>({ id: "c", name: "Original", db_type: "oracle", host: "localhost", port: 1521, username: "Owner", password: "" });
  const selected = ref<NativeJobRef | undefined>(target);
  const context = ref<NativeJobScope | undefined>(scope);
  const onFinished = vi.fn();
  const onTargetObserved = vi.fn();
  const owner = effectScope();
  scopes.push(owner);
  const execution = owner.run(() => useNativeJobExecution({ connection: () => connection.value, database: () => "", scope: () => context.value, selected: () => selected.value, source: () => "admin", onFinished, onTargetObserved }))!;
  return { execution, connection, selected, context, onFinished, onTargetObserved, owner };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  rpc.guard.mockImplementation((options: { execute: () => Promise<unknown> }) => options.execute());
  rpc.prepare.mockResolvedValue(plan);
  rpc.apply.mockResolvedValue(status());
});
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
  vi.useRealTimers();
});

describe("native job page execution", () => {
  it("observes dispatch while the apply receipt waits and never replaces newer status with the late receipt", async () => {
    const { execution, onFinished } = setup();
    const receipt = deferred<NativeJobOperationStatus>();
    rpc.apply.mockReturnValueOnce(receipt.promise);
    rpc.status.mockResolvedValue({ ...status("running"), steps: [{ id: "run", state: "dispatching", reason: null, vendorCode: null }] });
    await execution.prepare(mutation);
    const applying = execution.apply();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);
    expect(execution.execution.value?.status.steps[0]?.state).toBe("dispatching");
    expect(rpc.status).toHaveBeenCalledExactlyOnceWith("operation");
    rpc.status.mockResolvedValue(status());
    await vi.advanceTimersByTimeAsync(400);
    expect(execution.execution.value?.status.state).toBe("finished");
    receipt.resolve(status("queued", "not_started"));
    await applying;
    expect(execution.execution.value?.status.state).toBe("finished");
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(rpc.apply).toHaveBeenCalledTimes(1);
  });
  it("revokes old UI callbacks across explicit refresh even if Core returns the same scope", async () => {
    const { execution, onFinished, onTargetObserved } = setup();
    const receipt = deferred<NativeJobOperationStatus>();
    rpc.apply.mockReturnValueOnce(receipt.promise);
    await execution.prepare(mutation);
    const applying = execution.apply();
    await Promise.resolve();
    execution.invalidateContext();
    receipt.resolve(status("finished", "verified"));
    await applying;
    expect(execution.previousExecution.value?.status).toEqual(status("finished", "verified"));
    expect(onFinished).not.toHaveBeenCalled();
    expect(onTargetObserved).not.toHaveBeenCalled();
    expect(rpc.apply).toHaveBeenCalledExactlyOnceWith("plan");
    rpc.prepare.mockResolvedValue({ ...plan, planId: "new-plan", operationId: "new-operation" });
    rpc.apply.mockResolvedValue({ ...status(), operationId: "new-operation" });
    await execution.prepare(mutation);
    await execution.apply();
    expect(onFinished).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: "new-operation" }));
    expect(execution.previousExecution.value).toBeUndefined();
  });
  it("keeps prior-context receipts observable without rebinding their target or reviving late previews", async () => {
    const { execution, context, selected, connection } = setup();
    await execution.prepare(mutation);
    await execution.apply();
    const preview = deferred<NativeJobPreparedPlan>();
    rpc.prepare.mockReturnValueOnce(preview.promise);
    const preparing = execution.prepare(mutation);
    execution.invalidateContext();
    const next = { ...scope, contextId: "new-context" };
    context.value = next;
    selected.value = { ...target, scope: next } as NativeJobRef;
    preview.resolve(plan);
    await preparing;
    expect(execution.preview.value).toBeUndefined();
    expect(execution.execution.value).toBeUndefined();
    expect(execution.previousExecution.value?.status.target).toEqual(target);
    rpc.status.mockResolvedValue(status("finished", "unknown"));
    await execution.observe();
    expect(rpc.status).toHaveBeenCalledExactlyOnceWith("operation", true);
    expect(execution.previousExecution.value?.status.outcome).toBe("unknown");
    expect(rpc.apply).toHaveBeenCalledTimes(1);
    connection.value = { ...connection.value, username: "Other" };
    expect(execution.previousExecution.value).toBeUndefined();
  });
  it("delivers a later effective target without repeating completion or moving a different selection", async () => {
    const { execution, selected, onFinished, onTargetObserved } = setup();
    const original = { kind: "dameng-native" as const, scope, jobId: "41", name: "Old Job" };
    const renamed = { ...original, name: "New Job" };
    selected.value = original;
    rpc.prepare.mockResolvedValue({ ...plan, target: original, steps: [{ id: "rename", label: "rename", sql: "reviewed rename" }] });
    rpc.apply.mockResolvedValue({ ...status("finished", "unknown"), target: original });
    onTargetObserved.mockImplementation((value: NativeJobOperationStatus) => {
      if (value.observedIdentity) selected.value = value.target!;
    });
    await execution.prepare({ action: "update", target: original, baseline: "revision", attributes: [{ name: "NAME", change: { kind: "set", value: "New Job" } }], arguments: [] });
    await execution.apply();
    rpc.status.mockResolvedValue({ ...status("finished", "unknown"), target: renamed, observedIdentity: { DBX_JOB_ID: "41", DBX_CREATED_AT: "creation", NAME: "New Job" } });
    await execution.observe();
    expect(selected.value).toEqual(renamed);
    expect(execution.execution.value?.status.outcome).toBe("unknown");
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onTargetObserved).toHaveBeenCalledTimes(2);
    const late = deferred<NativeJobOperationStatus>();
    rpc.status.mockReturnValueOnce(late.promise);
    const observing = execution.observe();
    selected.value = { ...original, jobId: "99", name: "Another Job" };
    late.resolve({ ...status("finished", "unknown"), target: renamed, observedIdentity: { DBX_JOB_ID: "41", DBX_CREATED_AT: "creation", NAME: "New Job" } });
    await observing;
    expect(selected.value).toMatchObject({ jobId: "99" });
    expect(onTargetObserved).toHaveBeenCalledTimes(2);
    expect(rpc.apply).toHaveBeenCalledTimes(1);
  });
  it("refreshes native observations manually after the request has finished without replay or permanent busy", async () => {
    const { execution, selected, onFinished } = setup();
    await execution.prepare(mutation);
    await execution.apply();
    const pending = deferred<NativeJobOperationStatus>();
    rpc.status.mockReturnValueOnce(pending.promise);
    const observing = execution.observe();
    expect(execution.observing.value).toBe(true);
    expect(execution.busy.value).toBe(false);
    expect(rpc.status).toHaveBeenCalledExactlyOnceWith("operation", true);
    selected.value = { ...target, name: "different job" } as NativeJobRef;
    pending.resolve({ ...status(), executionObservation: { observedAt: "first", association: "uncertain", reason: "request_uncertain", running: { status: "empty" }, history: { status: "empty" }, sources: {}, candidates: [] } });
    await observing;
    expect(execution.execution.value).toBeUndefined();
    expect(execution.observing.value).toBe(false);
    selected.value = target;
    expect(execution.execution.value?.status.outcome).toBe("accepted");
    expect(execution.execution.value?.status.executionObservation?.association).toBe("uncertain");
    expect(onFinished).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(rpc.status).toHaveBeenCalledTimes(1);
    expect(rpc.apply).toHaveBeenCalledTimes(1);
  });

  it("does not let an older observation overwrite the latest explicit refresh", async () => {
    const { execution } = setup();
    await execution.prepare(mutation);
    await execution.apply();
    const older = deferred<NativeJobOperationStatus>();
    const newer = deferred<NativeJobOperationStatus>();
    rpc.status.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = execution.observe();
    const second = execution.observe();
    newer.resolve({ ...status(), reason: "newer observation" });
    await second;
    older.resolve({ ...status(), reason: "older observation" });
    await first;
    expect(execution.execution.value?.status.reason).toBe("newer observation");
    expect(execution.execution.value?.status.outcome).toBe("accepted");
  });

  it("reviews the immutable backend preview through the existing context guard and applies only its plan ID", async () => {
    const { execution, onFinished } = setup();
    await execution.prepare(mutation);
    expect(execution.preview.value).toEqual(plan);
    await execution.apply();
    expect(rpc.guard).toHaveBeenCalledWith(expect.objectContaining({ connection: expect.objectContaining({ id: "c" }), database: "", reviewText: "native reviewed SQL", source: "admin" }));
    expect(rpc.apply).toHaveBeenCalledExactlyOnceWith("plan");
    expect(execution.execution.value?.status.outcome).toBe("accepted");
    expect(onFinished).toHaveBeenCalledExactlyOnceWith(status());
    await execution.apply();
    expect(rpc.apply).toHaveBeenCalledTimes(1);
  });

  it("rejects another selection or scope before requesting preview", async () => {
    const { execution } = setup();
    await expect(execution.prepare({ ...mutation, target: { ...target, name: "other" } as NativeJobRef })).rejects.toThrow("native_job_identity_mismatch");
    await expect(execution.prepare({ ...mutation, target: { ...target, scope: { ...scope, contextId: "other" } } })).rejects.toThrow("native_job_context_changed");
    expect(rpc.prepare).not.toHaveBeenCalled();
  });

  it("ignores a late preview after changing selection and retains the new selection's preview", async () => {
    const pending = deferred<NativeJobPreparedPlan>();
    rpc.prepare.mockReturnValueOnce(pending.promise);
    const { execution, selected } = setup();
    const first = execution.prepare(mutation);
    selected.value = { ...target, name: "other" } as NativeJobRef;
    const other = { ...plan, target: selected.value, planId: "other-plan" };
    rpc.prepare.mockResolvedValueOnce(other);
    await execution.prepare({ ...mutation, target: selected.value });
    pending.resolve(plan);
    await first;
    expect(execution.preview.value?.planId).toBe("other-plan");
  });

  it.each(["selection", "connection", "context"])("does not apply after %s changes while production confirmation is open", async (change) => {
    const confirmation = deferred<void>();
    rpc.guard.mockImplementation(async (options: { execute: () => Promise<unknown> }) => {
      await confirmation.promise;
      return options.execute();
    });
    const { execution, selected, connection, context } = setup();
    await execution.prepare(mutation);
    const applying = execution.apply();
    if (change === "selection") selected.value = { ...target, name: "other" } as NativeJobRef;
    if (change === "connection") connection.value.host = "different-host";
    if (change === "context") context.value = { ...scope, contextId: "new-context" };
    confirmation.resolve();
    await applying;
    expect(rpc.apply).not.toHaveBeenCalled();
    expect(execution.preview.value).toBeUndefined();
  });

  it("keeps a canceled confirmation available for review without sending a request", async () => {
    rpc.guard.mockResolvedValue(undefined);
    const { execution } = setup();
    await execution.prepare(mutation);
    await execution.apply();
    expect(execution.preview.value?.planId).toBe("plan");
    expect(rpc.apply).not.toHaveBeenCalled();
  });

  it("continues observing the original operation after dispatch without refreshing a different selection", async () => {
    const applied = deferred<NativeJobOperationStatus>();
    rpc.apply.mockReturnValue(applied.promise);
    rpc.status.mockResolvedValue(status());
    const { execution, selected, onFinished } = setup();
    await execution.prepare(mutation);
    const applying = execution.apply();
    selected.value = { ...target, name: "other" } as NativeJobRef;
    applied.resolve(status("running", "not_started"));
    await applying;
    expect(execution.execution.value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(400);
    expect(rpc.status).toHaveBeenCalledExactlyOnceWith("operation");
    expect(onFinished).not.toHaveBeenCalled();
    selected.value = target;
    expect(execution.execution.value?.status.outcome).toBe("accepted");
    expect(rpc.apply).toHaveBeenCalledTimes(1);
  });

  it("looks up a lost apply receipt and allows a read-only recheck after transport loss, never replay", async () => {
    rpc.apply.mockRejectedValue(new Error("apply response lost"));
    rpc.status.mockRejectedValueOnce(new Error("status transport unavailable"));
    const { execution } = setup();
    await execution.prepare(mutation);
    await execution.apply();
    expect(execution.execution.value?.status.outcome).toBe("unknown");
    expect(execution.execution.value?.error).toBe("status transport unavailable");
    rpc.status.mockResolvedValue(status("finished", "verified"));
    await execution.refresh();
    expect(execution.execution.value?.status.outcome).toBe("verified");
    expect(rpc.apply).toHaveBeenCalledTimes(1);
    expect(rpc.status).toHaveBeenCalledTimes(2);
  });

  it("uses operation cancellation instead of submitting native STOP and stops polling on page disposal", async () => {
    rpc.apply.mockResolvedValue(status("running", "not_started"));
    rpc.cancel.mockResolvedValue({ ...status("running", "not_started"), cancelRequested: true });
    const { execution, owner } = setup();
    await execution.prepare(mutation);
    await execution.apply();
    await execution.cancel();
    expect(rpc.cancel).toHaveBeenCalledExactlyOnceWith("operation");
    expect(rpc.prepare).toHaveBeenCalledTimes(1);
    expect(execution.execution.value?.status.cancelRequested).toBe(true);
    owner.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(rpc.status).not.toHaveBeenCalled();
    expect(rpc.cancel).toHaveBeenCalledTimes(1);
  });

  it("previews creation with its scope and does not invent a target before OUT returns", async () => {
    rpc.prepare.mockResolvedValue({ ...plan, target: null });
    const { execution } = setup();
    await execution.prepare({ action: "create", scope, definition: { kind: "legacy", what: "BEGIN NULL; END;", nextDate: "2026-10-21 00:00:00", interval: "null", enabled: false } });
    expect(execution.preview.value?.target).toBeNull();
    expect(rpc.prepare).toHaveBeenCalledTimes(1);
    expect(rpc.apply).not.toHaveBeenCalled();
  });

  it("keeps creation results beside the returned OUT identity when the page selects the new job", async () => {
    rpc.prepare.mockResolvedValue({ ...plan, target: null });
    const created: NativeJobRef = { scope, kind: "legacy", jobId: "900719925474099312345" };
    rpc.apply.mockResolvedValue({ ...status("finished", "verified"), target: created });
    const { execution, selected, onFinished } = setup();
    onFinished.mockImplementation(() => {
      selected.value = created;
    });
    await execution.prepare({ action: "create", scope, definition: { kind: "legacy", what: "BEGIN NULL; END;", nextDate: "2026-10-21 00:00:00", interval: "null", enabled: false } });
    await execution.apply();
    expect(execution.execution.value?.status.target).toEqual(created);
    expect(execution.execution.value?.status.outcome).toBe("verified");
  });
});
