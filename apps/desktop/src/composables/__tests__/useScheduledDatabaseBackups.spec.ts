import { describe, expect, it, vi } from "vitest";
import type { DatabaseBackupExecutionConfig, DatabaseBackupRun } from "../../lib/backup/scheduledDatabaseBackup";

const mocks = vi.hoisted(() => ({
  connection: { id: "mysql-1", name: "Local MySQL", db_type: "mysql" },
  listDatabases: vi.fn(async () => [{ name: "app" }]),
  beginSnapshot: vi.fn(async () => ({ sessionId: "snapshot-1" })),
  rollbackSnapshot: vi.fn(async () => {}),
  deleteFiles: vi.fn(async () => 0),
  cancelExport: vi.fn(async () => {}),
  clearExportCancellation: vi.fn(async () => {}),
  exportDatabase: vi.fn(),
  runDatabaseExport: vi.fn(),
  addTask: vi.fn(),
  registerCancel: vi.fn(),
  unregisterCancel: vi.fn(),
  updateTask: vi.fn(),
  markTaskCancelling: vi.fn(),
  restoreTaskRunning: vi.fn(),
  nextId: 0,
}));

vi.mock("@/lib/backend/api", () => ({
  listDatabases: mocks.listDatabases,
  beginDatabaseBackupSnapshot: mocks.beginSnapshot,
  rollbackManualTransaction: mocks.rollbackSnapshot,
  deleteDatabaseBackupFiles: mocks.deleteFiles,
  cancelDatabaseExport: mocks.cancelExport,
  clearDatabaseExportCancellation: mocks.clearExportCancellation,
}));

vi.mock("@/lib/export/databaseExport", () => ({
  buildAllDatabaseExportPlan: () => [{ database: "app", schema: "app", fileStem: "app", displayName: "app" }],
  generateDatabaseExportId: () => `run-${++mocks.nextId}`,
  runDatabaseExportUntilTerminal: mocks.runDatabaseExport,
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => mocks.connection,
    ensureConnected: vi.fn(async () => {}),
    initFromDisk: vi.fn(async () => {}),
  }),
}));
vi.mock("@/composables/useExportTracker", () => ({
  useExportTracker: () => ({
    addDatabaseExportTask: mocks.addTask,
    registerTaskCancelHandler: mocks.registerCancel,
    unregisterTaskCancelHandler: mocks.unregisterCancel,
    updateDatabaseExportTask: mocks.updateTask,
    markDatabaseExportTaskCancelling: mocks.markTaskCancelling,
    restoreDatabaseExportTaskRunning: mocks.restoreTaskRunning,
  }),
}));

import { useScheduledDatabaseBackups } from "../useScheduledDatabaseBackups";

const config: DatabaseBackupExecutionConfig = {
  connectionId: "mysql-1",
  databases: ["app"],
  tableFilterMode: "all",
  tablePatterns: [],
  destinationDirectory: "/backups",
  includeStructure: true,
  includeData: true,
  includeObjects: true,
  dropTableIfExists: false,
  outputCompression: "none",
};

describe("useScheduledDatabaseBackups one-shot execution", () => {
  it("deletes multiple completed runs and all of their backup files", async () => {
    const backup = useScheduledDatabaseBackups();
    const firstRun = {
      id: "delete-many-first",
      scheduleName: "First backup",
      connectionId: "mysql-1",
      connectionName: "Local MySQL",
      destinationDirectory: "/backups",
      trigger: "scheduled",
      source: "scheduled",
      status: "success",
      startedAt: "2026-09-08T01:00:00.000Z",
      files: [{ displayName: "first.sql", filePath: "/backups/first.sql" }],
    } satisfies DatabaseBackupRun;
    const secondRun = {
      id: "delete-many-second",
      scheduleName: "Second backup",
      connectionId: "mysql-1",
      connectionName: "Local MySQL",
      destinationDirectory: "/backups",
      trigger: "scheduled",
      source: "scheduled",
      status: "failed",
      startedAt: "2026-09-08T02:00:00.000Z",
      files: [{ displayName: "second.sql", filePath: "/backups/second.sql" }],
    } satisfies DatabaseBackupRun;
    backup.runs.value.push(firstRun, secondRun);
    mocks.deleteFiles.mockClear();

    try {
      await backup.deleteRuns([firstRun.id, secondRun.id]);

      expect(mocks.deleteFiles).toHaveBeenCalledWith(["/backups/first.sql", "/backups/second.sql"], ["/backups"]);
      expect(backup.runs.value).not.toContainEqual(expect.objectContaining({ id: firstRun.id }));
      expect(backup.runs.value).not.toContainEqual(expect.objectContaining({ id: secondRun.id }));
    } finally {
      backup.runs.value = backup.runs.value.filter((run) => run.id !== firstRun.id && run.id !== secondRun.id);
    }
  });

  it("keeps a shared backup path when deleting one of its history records", async () => {
    const backup = useScheduledDatabaseBackups();
    const sharedPath = "/backups/before-migration__app.sql";
    const firstRun = {
      id: "shared-path-first",
      scheduleName: "First backup",
      connectionId: "mysql-1",
      connectionName: "Local MySQL",
      trigger: "scheduled",
      source: "scheduled",
      status: "success",
      startedAt: "2026-09-08T01:00:00.000Z",
      files: [{ displayName: "first.sql", filePath: sharedPath }],
    } satisfies DatabaseBackupRun;
    const secondRun = { ...firstRun, id: "shared-path-second", startedAt: "2026-09-08T02:00:00.000Z" } satisfies DatabaseBackupRun;
    backup.runs.value.push(firstRun, secondRun);
    mocks.deleteFiles.mockClear();

    try {
      await backup.deleteRun(firstRun.id);

      expect(mocks.deleteFiles).not.toHaveBeenCalled();
      expect(backup.runs.value).not.toContainEqual(expect.objectContaining({ id: firstRun.id }));
      expect(backup.runs.value).toContainEqual(expect.objectContaining({ id: secondRun.id }));
    } finally {
      backup.runs.value = backup.runs.value.filter((run) => run.id !== firstRun.id && run.id !== secondRun.id);
    }
  });

  it("executes one-shot backups through the shared exporter without a schedule", async () => {
    mocks.runDatabaseExport.mockImplementationOnce(async (_request: unknown, onProgress: (progress: unknown) => void) => {
      onProgress({ status: "Done", objectIndex: 1, totalObjects: 1, currentObject: "app" });
      return { status: "Done", objectIndex: 1, totalObjects: 1, currentObject: "app" };
    });

    const backup = useScheduledDatabaseBackups();
    const scheduleCountBefore = backup.schedules.value.length;
    const run = await backup.runOneShot(config, "One-time backup");

    expect(run).toEqual(expect.objectContaining({ status: "success", source: "one-shot", trigger: "manual", scheduleId: undefined }));
    expect(run).not.toHaveProperty("nextRunAt");
    expect(backup.schedules.value).toHaveLength(scheduleCountBefore);
    expect(mocks.runDatabaseExport).toHaveBeenCalledWith(expect.objectContaining({ preventOverwrite: true }), expect.any(Function));
    expect(mocks.addTask).toHaveBeenCalledWith(expect.any(String), "One-time backup", "/backups", "manual");
  });

  it("rejects a repeated one-shot when its custom file name resolves to an existing path", async () => {
    mocks.runDatabaseExport.mockImplementation(async (_request: unknown, onProgress: (progress: unknown) => void) => {
      const progress = { status: "Done", objectIndex: 1, totalObjects: 1, currentObject: "app" };
      onProgress(progress);
      return progress;
    });
    const backup = useScheduledDatabaseBackups();
    const customConfig = { ...config, fileNamePattern: "before-migration" };
    let runIds: string[] = [];

    try {
      const firstRun = await backup.runOneShot(customConfig, "One-time backup");
      runIds = [firstRun?.id].filter((id): id is string => Boolean(id));
      const exportCallCount = mocks.runDatabaseExport.mock.calls.length;
      const secondRun = await backup.runOneShot(customConfig, "One-time backup");
      if (secondRun?.id) runIds.push(secondRun.id);

      expect(firstRun).toEqual(expect.objectContaining({ status: "success" }));
      expect(secondRun).toEqual(expect.objectContaining({ status: "failed", files: [] }));
      expect(secondRun?.error).toContain("already used by another run");
      expect(mocks.runDatabaseExport).toHaveBeenCalledTimes(exportCallCount);
    } finally {
      const ids = new Set(runIds);
      backup.runs.value = backup.runs.value.filter((run) => !ids.has(run.id));
    }
  });

  it("does not delete a pre-existing file when the exporter rejects overwrite", async () => {
    mocks.runDatabaseExport.mockRejectedValueOnce(new Error("Backup file already exists: /backups/before-migration__app.sql"));
    const backup = useScheduledDatabaseBackups();
    const result = await backup.runOneShot({ ...config, fileNamePattern: "before-migration" }, "One-time backup");

    expect(result).toEqual(expect.objectContaining({ status: "failed", files: [] }));
    expect(mocks.deleteFiles).not.toHaveBeenCalled();
  });

  it("prevents a second one-shot while one is already running", async () => {
    const backup = useScheduledDatabaseBackups();
    const activeRun = {
      id: "active-one-shot",
      scheduleName: "One-time backup",
      connectionId: "mysql-1",
      connectionName: "Local MySQL",
      trigger: "manual",
      source: "one-shot",
      status: "running",
      startedAt: new Date().toISOString(),
      files: [],
    } satisfies DatabaseBackupRun;
    backup.runs.value.push(activeRun);
    backup.activeRunIds.add(activeRun.id);
    const exportCallCount = mocks.runDatabaseExport.mock.calls.length;

    try {
      expect(await backup.runOneShot(config, "One-time backup")).toBeNull();
      expect(mocks.runDatabaseExport).toHaveBeenCalledTimes(exportCallCount);
    } finally {
      backup.activeRunIds.delete(activeRun.id);
      backup.runs.value = backup.runs.value.filter((run: DatabaseBackupRun) => run.id !== activeRun.id);
    }
  });

  it("cancels an active one-shot through the shared export cancellation path", async () => {
    mocks.cancelExport.mockClear();
    mocks.deleteFiles.mockClear();
    let resolveExport!: (progress: { status: "Cancelled"; objectIndex: number; totalObjects: number; currentObject: string }) => void;
    mocks.runDatabaseExport.mockImplementationOnce(
      (_request: unknown, onProgress: (progress: unknown) => void) =>
        new Promise((resolve) => {
          resolveExport = (progress) => {
            onProgress(progress);
            resolve(progress);
          };
        }),
    );

    const backup = useScheduledDatabaseBackups();
    const pendingRun = backup.runOneShot(config, "One-time backup");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const activeRunId = [...backup.activeRunIds][0];
    expect(activeRunId).toBeTruthy();

    await backup.cancelRun(activeRunId!);
    expect(mocks.cancelExport).toHaveBeenCalledWith(activeRunId);
    expect(mocks.cancelExport).toHaveBeenCalledWith(`${activeRunId}-1`);
    expect(mocks.markTaskCancelling).toHaveBeenCalledWith(activeRunId);
    expect(backup.cancellingRunIds.has(activeRunId!)).toBe(true);
    await backup.cancelRun(activeRunId!);
    expect(mocks.cancelExport).toHaveBeenCalledTimes(2);
    resolveExport({ status: "Cancelled", objectIndex: 0, totalObjects: 1, currentObject: "app" });

    const finishedRun = await pendingRun;
    expect(finishedRun).toEqual(expect.objectContaining({ status: "cancelled", source: "one-shot", files: [] }));
    expect(mocks.deleteFiles).toHaveBeenCalledWith([expect.stringContaining(activeRunId!)], ["/backups"]);
    expect(backup.runs.value.find((run) => run.id === activeRunId)).toEqual(expect.objectContaining({ status: "cancelled", files: [] }));
    expect(backup.cancellingRunIds.has(activeRunId!)).toBe(false);
  });

  it("stops after cancelling during database discovery without creating a snapshot", async () => {
    mocks.beginSnapshot.mockClear();
    mocks.cancelExport.mockClear();
    let resolveDatabases!: (databases: Array<{ name: string }>) => void;
    mocks.listDatabases.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDatabases = resolve;
        }),
    );

    const backup = useScheduledDatabaseBackups();
    const pendingRun = backup.runOneShot(config, "One-time backup");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const activeRunId = [...backup.activeRunIds][0];
    expect(activeRunId).toBeTruthy();

    await backup.cancelRun(activeRunId!);
    expect(mocks.cancelExport).toHaveBeenCalledWith(activeRunId);
    resolveDatabases([{ name: "app" }]);

    const finishedRun = await pendingRun;
    expect(finishedRun).toEqual(expect.objectContaining({ status: "cancelled", files: [] }));
    expect(mocks.beginSnapshot).not.toHaveBeenCalled();
  });

  it("signals the backup run while snapshot creation is pending", async () => {
    mocks.beginSnapshot.mockClear();
    mocks.cancelExport.mockClear();
    let resolveSnapshot!: (snapshot: { sessionId: string }) => void;
    mocks.beginSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );

    const backup = useScheduledDatabaseBackups();
    const pendingRun = backup.runOneShot(config, "One-time backup");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const activeRunId = [...backup.activeRunIds][0];
    expect(activeRunId).toBeTruthy();
    expect(mocks.beginSnapshot).toHaveBeenCalledWith("mysql-1", "app", activeRunId);

    await backup.cancelRun(activeRunId!);
    expect(mocks.cancelExport).toHaveBeenCalledWith(activeRunId);
    resolveSnapshot({ sessionId: "snapshot-pending" });

    const finishedRun = await pendingRun;
    expect(finishedRun).toEqual(expect.objectContaining({ status: "cancelled", files: [] }));
    expect(mocks.rollbackSnapshot).toHaveBeenCalledWith("snapshot-pending");
    expect(mocks.clearExportCancellation).toHaveBeenCalledWith(activeRunId);
  });
});
