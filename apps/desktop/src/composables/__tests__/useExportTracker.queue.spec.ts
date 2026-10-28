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
});
