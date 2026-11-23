import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backend/browserAppStateStorage", () => ({
  loadBrowserAppState: vi.fn(),
  saveBrowserAppState: vi.fn(),
}));
vi.mock("@/lib/backend/api", () => ({}));
vi.mock("@/lib/export/exportPath", () => ({ autoRevealExportedPathIfConfigured: vi.fn() }));
vi.mock("@/lib/schema/oracleRoutineDeploy", () => ({}));

describe("export task persistence", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("keeps only the fields the task UI renders", async () => {
    const { serializeExportTasks } = await import("@/lib/export/exportTaskPersistence");
    const snapshot = serializeExportTasks([
      {
        exportId: "task-1",
        kind: "data-transfer",
        tableName: "orders",
        format: "csv",
        filePath: "/tmp/orders.csv",
        rowsExported: 12,
        totalRows: 100,
        status: "Running",
        errorMessage: null,
        logLines: [{ at: 1, key: "transfer.log.started", level: "info" }],
        dataTransferRequest: { source: "secret-payload" },
        onRemove: () => undefined,
        canRecoverCancellation: true,
      } as never,
    ]);

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      exportId: "task-1",
      kind: "data-transfer",
      status: "Running",
      rowsExported: 12,
      totalRows: 100,
    });
    expect(snapshot[0].logLines).toEqual([{ at: 1, key: "transfer.log.started", level: "info" }]);
    expect(snapshot[0]).not.toHaveProperty("dataTransferRequest");
    expect(snapshot[0]).not.toHaveProperty("onRemove");
    expect(snapshot[0]).not.toHaveProperty("canRecoverCancellation");
  });

  it("skips removed tasks and caps the snapshot length", async () => {
    const { serializeExportTasks } = await import("@/lib/export/exportTaskPersistence");
    const base = {
      kind: "table-export" as const,
      tableName: "t",
      format: "csv",
      filePath: "/tmp/t.csv",
      rowsExported: 0,
      totalRows: null,
      status: "Done" as const,
      errorMessage: null,
    };
    const tasks = Array.from({ length: 30 }, (_, index) => ({
      ...base,
      exportId: `task-${index}`,
    }));
    tasks.push({ ...base, exportId: "removed", removed: true });
    tasks.push({ ...base, exportId: "hidden", canRemove: false });

    const snapshot = serializeExportTasks(tasks as never);

    expect(snapshot).toHaveLength(25);
    expect(snapshot.map((task) => task.exportId)).not.toContain("removed");
    expect(snapshot.map((task) => task.exportId)).not.toContain("hidden");
    expect(snapshot[snapshot.length - 1].exportId).toBe("task-29");
  });

  it("forgets finished tasks once they are a day old", async () => {
    const { serializeExportTasks } = await import("@/lib/export/exportTaskPersistence");
    const base = {
      kind: "table-export" as const,
      tableName: "t",
      format: "csv",
      filePath: "/tmp/t.csv",
      rowsExported: 0,
      totalRows: null,
      status: "Done" as const,
      errorMessage: null,
    };
    const snapshot = serializeExportTasks([
      { ...base, exportId: "fresh", finishedAt: Date.now() - 60_000 },
      { ...base, exportId: "stale", finishedAt: Date.now() - 48 * 60 * 60 * 1000 },
    ] as never);

    expect(snapshot.map((task) => task.exportId)).toEqual(["fresh"]);
  });

  it("forgets a restored task once its interruption is a day old", async () => {
    const { serializeExportTasks } = await import("@/lib/export/exportTaskPersistence");
    const snapshot = serializeExportTasks([
      {
        exportId: "restored-recent",
        kind: "table-export",
        tableName: "t",
        format: "csv",
        filePath: "/tmp/t.csv",
        rowsExported: 0,
        totalRows: null,
        status: "Unknown",
        errorMessage: null,
        restored: true,
        finishedAt: Date.now() - 60_000,
      },
      {
        exportId: "restored-stale",
        kind: "table-export",
        tableName: "t",
        format: "csv",
        filePath: "/tmp/t.csv",
        rowsExported: 0,
        totalRows: null,
        status: "Unknown",
        errorMessage: null,
        restored: true,
        finishedAt: Date.now() - 48 * 60 * 60 * 1000,
      },
    ] as never);

    expect(snapshot.map((task) => task.exportId)).toEqual(["restored-recent"]);
  });

  it("restores an interrupted task as unknown and keeps its pre-crash log", async () => {
    const { deserializeExportTasks } = await import("@/lib/export/exportTaskPersistence");
    const restored = deserializeExportTasks([
      {
        exportId: "task-1",
        kind: "data-transfer",
        tableName: "orders",
        format: "csv",
        filePath: "/tmp/orders.csv",
        rowsExported: 12,
        totalRows: 100,
        status: "Writing",
        errorMessage: null,
        logLines: [
          { at: 1, key: "transfer.log.started", level: "info" },
          { at: 2, key: "transfer.log.tableStarted", level: "info", params: { table: "orders" } },
          { at: 3, key: "broken" },
        ],
      },
    ]);

    expect(restored).toHaveLength(1);
    expect(restored[0].status).toBe("Unknown");
    expect(restored[0].canCancel).toBe(false);
    expect(restored[0].canRemove).toBe(true);
    expect(restored[0].logLines).toHaveLength(2);
    expect(restored[0].logLines?.[1].params).toEqual({ table: "orders" });
  });

  it("keeps terminal statuses and drops entries it cannot render", async () => {
    const { deserializeExportTasks } = await import("@/lib/export/exportTaskPersistence");
    const restored = deserializeExportTasks([
      { exportId: "done", kind: "table-export", status: "Done" },
      { exportId: "error", kind: "sql-file", status: "Error" },
      { exportId: "cancelled", kind: "database-export", status: "Cancelled" },
      { exportId: "unknown-kind", kind: "not-a-kind", status: "Running" },
      { exportId: "unknown-status", kind: "table-export", status: "Exploded" },
      { kind: "table-export", status: "Running" },
      null,
    ]);

    expect(restored.map((task) => task.exportId)).toEqual(["done", "error", "cancelled"]);
    expect(restored.map((task) => task.status)).toEqual(["Done", "Error", "Cancelled"]);
  });

  it("survives a storage failure instead of breaking the startup path", async () => {
    const storage = await import("@/lib/backend/browserAppStateStorage");
    vi.mocked(storage.loadBrowserAppState).mockRejectedValueOnce(new Error("indexeddb gone"));
    const { loadPersistedExportTasks } = await import("@/lib/export/exportTaskPersistence");

    await expect(loadPersistedExportTasks()).resolves.toEqual([]);
  });
});

describe("export tracker task restoration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("merges the previous session's tasks into the tracker as unknown", async () => {
    const storage = await import("@/lib/backend/browserAppStateStorage");
    vi.mocked(storage.loadBrowserAppState).mockResolvedValue([
      {
        exportId: "crashed-task",
        kind: "data-transfer",
        tableName: "orders",
        format: "csv",
        filePath: "/tmp/orders.csv",
        rowsExported: 5,
        totalRows: 100,
        status: "Running",
        errorMessage: null,
        logLines: [{ at: 1, key: "transfer.log.started", level: "info" }],
      },
    ]);

    const { restoreExportTasksFromStorage, useExportTracker } = await import("@/composables/useExportTracker");
    await restoreExportTasksFromStorage();
    const tracker = useExportTracker();

    const task = tracker.tasks.value.find((item) => item.exportId === "crashed-task");
    expect(task).toBeDefined();
    expect(task?.status).toBe("Unknown");
    expect(task?.restored).toBe(true);
    expect(typeof task?.finishedAt).toBe("number");
    expect(task?.logLines).toHaveLength(1);
    // A restored task has no live handle, so it must not block app updates.
    expect(tracker.activeCount.value).toBe(0);
    expect(tracker.hasActive.value).toBe(false);
  });
});
