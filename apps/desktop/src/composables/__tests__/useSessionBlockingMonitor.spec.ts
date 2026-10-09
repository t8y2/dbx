import { effectScope, shallowRef } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionBlockingMonitor } from "../useSessionBlockingMonitor";
import { createSessionBlockingMonitor, type MonitorContext, type SessionSnapshot } from "@/lib/database/sessionBlockingMonitor";
import type { QueryResult } from "@/types/database";
vi.mock("@/lib/backend/api", () => ({}));
const context = () => shallowRef<MonitorContext | null>({ connectionId: "one", database: "db", engine: "oracle" });
const sample = (): SessionSnapshot => ({ startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), sessions: [], edges: [], limitations: [] });
afterEach(() => vi.useRealTimers());
describe("session monitor lifetime", () => {
  it("discards previous connection responses and cancels the old request", async () => {
    const target = context();
    let finish!: (snapshot: SessionSnapshot) => void;
    const service = {
      collect: vi.fn().mockImplementation(
        () =>
          new Promise<SessionSnapshot>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const scope = effectScope();
    const state = scope.run(() => useSessionBlockingMonitor(target, service))!;
    const pending = state.refresh();
    const signal = service.collect.mock.calls[0][1] as AbortSignal;
    target.value = { ...target.value!, connectionId: "two" };
    finish(sample());
    await pending;
    expect(signal.aborted).toBe(true);
    expect(state.snapshot.value).toBeNull();
    expect(state.pending.value).toBe(false);
    scope.stop();
  });
  it("limits refresh frequency, marks old snapshots stale and stops automatic work on close", async () => {
    vi.useFakeTimers();
    const target = context();
    const service = { collect: vi.fn().mockImplementation(async () => sample()) };
    const scope = effectScope();
    const state = scope.run(() => useSessionBlockingMonitor(target, service))!;
    await state.refresh();
    await state.refresh();
    expect(service.collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(state.stale.value).toBe(true);
    state.autoRefresh.value = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.collect).toHaveBeenCalledTimes(2);
    target.value = null;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(service.collect).toHaveBeenCalledTimes(2);
    expect(state.snapshot.value).toBeNull();
    expect(state.autoRefresh.value).toBe(false);
    scope.stop();
  });
  it("retains the previous snapshot as stale when a refresh fails", async () => {
    vi.useFakeTimers();
    const service = { collect: vi.fn().mockResolvedValueOnce(sample()).mockRejectedValueOnce(new Error("ORA-01031 private")) };
    const scope = effectScope();
    const state = scope.run(() => useSessionBlockingMonitor(context(), service))!;
    await state.refresh();
    const previous = state.snapshot.value;
    await vi.advanceTimersByTimeAsync(5_000);
    await state.refresh();
    expect(state.snapshot.value).toBe(previous);
    expect(state.error.value).toBe("permission_denied");
    expect(state.stale.value).toBe(true);
    scope.stop();
  });
  it.each([
    ["timeout", "resolve"],
    ["timeout", "reject"],
    ["cancelled", "resolve"],
    ["cancelled", "reject"],
  ])("releases real collection on %s and ignores a late %s after a new refresh", async (reason, lateOutcome) => {
    vi.useFakeTimers();
    const empty = { columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 } as QueryResult;
    let finish!: (value: QueryResult) => void;
    let fail!: (cause: Error) => void;
    const backend = {
      executeQuery: vi
        .fn()
        .mockResolvedValueOnce(empty)
        .mockImplementationOnce(
          () =>
            new Promise<QueryResult>((resolve, reject) => {
              finish = resolve;
              fail = reject;
            }),
        )
        .mockResolvedValue(empty),
      cancelQuery: vi.fn().mockImplementation(() => new Promise<void>(() => {})),
    };
    const scope = effectScope();
    const state = scope.run(() => useSessionBlockingMonitor(context(), createSessionBlockingMonitor(backend)))!;
    try {
      await state.refresh();
      const previous = state.snapshot.value;
      await vi.advanceTimersByTimeAsync(5_000);
      const waiting = state.refresh();
      expect(state.pending.value).toBe(true);
      if (reason === "timeout") await vi.advanceTimersByTimeAsync(30_000);
      else state.cancel();
      // Neither executeQuery nor cancelQuery has returned at this point.
      await waiting;
      expect(state.pending.value).toBe(false);
      expect(state.error.value).toBe(reason);
      expect(state.snapshot.value).toBe(previous);
      expect(state.stale.value).toBe(true);
      expect(backend.cancelQuery).toHaveBeenCalledWith(backend.executeQuery.mock.calls[1][4]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(state.canRefresh.value).toBe(true);
      await state.refresh();
      const current = state.snapshot.value;
      expect(current).not.toBe(previous);
      if (lateOutcome === "resolve") finish(empty);
      else fail(new Error("ORA-01031 late private error"));
      await vi.advanceTimersByTimeAsync(0);
      expect(state.snapshot.value).toBe(current);
      expect(state.error.value).toBeNull();
      expect(state.pending.value).toBe(false);
      expect(backend.executeQuery).toHaveBeenCalledTimes(3);
    } finally {
      scope.stop();
    }
  });
  it("settles real collection when the connection changes despite a backend that never returns", async () => {
    const backend = {
      executeQuery: vi.fn().mockImplementation(() => new Promise<QueryResult>(() => {})),
      cancelQuery: vi.fn().mockImplementation(() => new Promise<void>(() => {})),
    };
    const target = context();
    const scope = effectScope();
    const state = scope.run(() => useSessionBlockingMonitor(target, createSessionBlockingMonitor(backend)))!;
    try {
      const waiting = state.refresh();
      target.value = { ...target.value!, connectionId: "two" };
      await waiting;
      expect(state.pending.value).toBe(false);
      expect(state.canRefresh.value).toBe(true);
      expect(state.error.value).toBeNull();
      expect(state.snapshot.value).toBeNull();
      expect(backend.cancelQuery).toHaveBeenCalledTimes(1);
    } finally {
      scope.stop();
    }
  });
});
