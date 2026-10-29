import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backend/api", () => ({ cancelTableExport: vi.fn() }));
vi.mock("@/lib/export/exportPath", () => ({ autoRevealExportedPathIfConfigured: vi.fn() }));
vi.mock("@/lib/schema/oracleRoutineDeploy", () => ({}));

function completion() {
  let finish!: (outcome: "settled" | "unknown") => void;
  const promise = new Promise<"settled" | "unknown">((resolve) => {
    finish = resolve;
  });
  return { run: vi.fn(() => promise), finish };
}

describe("export tracker queue", () => {
  beforeEach(() => vi.resetModules());

  it("shows waiting tasks without elapsed time and cancels them without backend calls", async () => {
    const { useExportTracker } = await import("../useExportTracker");
    const api = await import("@/lib/backend/api");
    const tracker = useExportTracker();
    const first = completion();
    tracker.submitExportTask(tracker.addTask("first", "csv", "first.csv"), "queued", first.run);
    const waiting = tracker.addTask("second", "csv", "second.csv");
    const second = completion();
    tracker.submitExportTask(waiting, "queued", second.run);

    expect(waiting.status).toBe("Queued");
    expect(waiting.startedAt).toBeUndefined();
    expect(tracker.activeCount.value).toBe(2);
    tracker.clearFinished();
    expect(tracker.tasks.value).toHaveLength(2);
    await tracker.cancelTask(waiting.exportId);
    expect(waiting.status).toBe("Cancelled");
    expect(api.cancelTableExport).not.toHaveBeenCalled();
    first.finish("settled");
    await Promise.resolve();
    expect(second.run).not.toHaveBeenCalled();
  });

  it("retains unknown operations as active and does not clear or release them", async () => {
    const { useExportTracker } = await import("../useExportTracker");
    const tracker = useExportTracker();
    const first = completion();
    const running = tracker.addTask("first", "csv", "first.csv");
    tracker.submitExportTask(running, "queued", first.run);
    const second = completion();
    tracker.submitExportTask(tracker.addTask("second", "csv", "second.csv"), "queued", second.run);
    first.finish("unknown");
    await Promise.resolve();

    expect(running.status).toBe("Unknown");
    expect(tracker.activeCount.value).toBe(2);
    tracker.clearFinished();
    expect(tracker.tasks.value).toHaveLength(2);
    expect(second.run).not.toHaveBeenCalled();
  });

  it("releases a removed unknown task and starts the next one without retrying it", async () => {
    const { useExportTracker } = await import("../useExportTracker");
    const tracker = useExportTracker();
    const first = completion();
    const running = tracker.addTask("first", "csv", "first.csv");
    tracker.submitExportTask(running, "queued", first.run);
    const second = completion();
    const waiting = tracker.addTask("second", "csv", "second.csv");
    tracker.submitExportTask(waiting, "queued", second.run);
    first.finish("unknown");
    await Promise.resolve();

    tracker.removeTask(running.exportId);

    expect(tracker.tasks.value.map((task) => task.exportId)).toEqual([waiting.exportId]);
    expect(tracker.activeCount.value).toBe(1);
    expect(waiting.status).toBe("Running");
    expect(second.run).toHaveBeenCalledOnce();
    expect(first.run).toHaveBeenCalledOnce();

    second.finish("settled");
    await Promise.resolve();
  });

  it.each(["resolved", "rejected", "pending"])("offers manual recovery when cancellation is %s but has no terminal", async (cancellation) => {
    vi.useFakeTimers();
    try {
      const { useExportTracker } = await import("../useExportTracker");
      const tracker = useExportTracker();
      const first = completion();
      const running = tracker.addTask("first", "csv", "first.csv");
      tracker.submitExportTask(running, "queued", first.run);
      const second = completion();
      tracker.submitExportTask(tracker.addTask("second", "csv", "second.csv"), "queued", second.run);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(running.status).toBe("Running");
      expect(running.canRecoverCancellation).not.toBe(true);
      tracker.registerTaskCancelHandler(running.exportId, () => {
        running.status = "Cancelling";
        if (cancellation === "rejected") return Promise.reject(new Error("cancel response lost"));
        if (cancellation === "pending") return new Promise<void>(() => {});
      });
      void tracker.cancelTask(running.exportId);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(running.canRecoverCancellation).not.toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(running.canRecoverCancellation).toBe(true);
      expect(running.status).toBe("Cancelling");
      expect(second.run).not.toHaveBeenCalled();
      expect(first.run).toHaveBeenCalledOnce();
      tracker.recoverCancelledTask(running.exportId);
      expect(running.removed).toBe(true);
      expect(second.run).toHaveBeenCalledOnce();
      tracker.recoverCancelledTask(running.exportId);
      first.finish("settled");
      await Promise.resolve();
      expect(second.run).toHaveBeenCalledOnce();
      expect(tracker.tasks.value).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a batch from its current child without needing an enabled cancel button", async () => {
    vi.useFakeTimers();
    try {
      const { useExportTracker } = await import("../useExportTracker");
      const tracker = useExportTracker();
      const root = tracker.addTask("batch", "csv", "/exports");
      const first = completion();
      tracker.submitExportTask(root, "queued", first.run);
      const child = tracker.addTask("child", "csv", "/exports/child.csv");
      tracker.registerTaskCancelHandler(
        child.exportId,
        () => {
          root.status = "Cancelling";
          child.status = "Cancelling";
          child.canCancel = false;
        },
        root.exportId,
      );
      const second = completion();
      tracker.submitExportTask(tracker.addTask("next", "csv", "/next.csv"), "queued", second.run);
      await tracker.cancelTask(child.exportId);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(child.canRecoverCancellation).toBe(true);
      expect(second.run).not.toHaveBeenCalled();
      tracker.recoverCancelledTask(child.exportId);
      expect(root.removed).toBe(true);
      expect(child.removed).toBe(true);
      expect(second.run).toHaveBeenCalledOnce();
      first.finish("settled");
      second.finish("settled");
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears recovery eligibility when the real task finishes before the deadline", async () => {
    vi.useFakeTimers();
    try {
      const { useExportTracker } = await import("../useExportTracker");
      const tracker = useExportTracker();
      const task = tracker.addTask("first", "csv", "first.csv");
      const first = completion();
      tracker.submitExportTask(task, "queued", first.run);
      await tracker.cancelTask(task.exportId);
      tracker.updateTableExportTask(task.exportId, { exportId: task.exportId, tableName: "first", rowsExported: 0, totalRows: null, status: "Cancelled" });
      first.finish("settled");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(task.canRecoverCancellation).not.toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      tracker.recoverCancelledTask(task.exportId);
      expect(tracker.tasks.value).toContain(task);
    } finally {
      vi.useRealTimers();
    }
  });
});
