import { describe, expect, it, vi } from "vitest";
import type { DatabaseBackupExecutionConfig, DatabaseBackupRun } from "../../lib/backup/scheduledDatabaseBackup";

const mocks = vi.hoisted(() => ({
  connection: { id: "mysql-1", name: "Local MySQL", db_type: "mysql" },
  listDatabases: vi.fn(async () => [{ name: "app" }]),
  beginSnapshot: vi.fn(async () => ({ sessionId: "snapshot-1" })),
  rollbackSnapshot: vi.fn(async () => {}),
  deleteFiles: vi.fn(async () => 0),
  cancelExport: vi.fn(async () => {}),
  exportDatabase: vi.fn(),
  runDatabaseExport: vi.fn(),
  addTask: vi.fn(),
  registerCancel: vi.fn(),
  unregisterCancel: vi.fn(),
  updateTask: vi.fn(),
  nextId: 0,
}));

vi.mock("@/lib/backend/api", () => ({
  listDatabases: mocks.listDatabases,
  beginDatabaseBackupSnapshot: mocks.beginSnapshot,
  rollbackManualTransaction: mocks.rollbackSnapshot,
  deleteDatabaseBackupFiles: mocks.deleteFiles,
  cancelDatabaseExport: mocks.cancelExport,
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
};

describe("useScheduledDatabaseBackups one-shot execution", () => {
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
    expect(mocks.addTask).toHaveBeenCalledWith(expect.any(String), "One-time backup", "/backups", "manual");
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
    expect(mocks.cancelExport).toHaveBeenCalledWith(`${activeRunId}-1`);
    resolveExport({ status: "Cancelled", objectIndex: 0, totalObjects: 1, currentObject: "app" });

    const finishedRun = await pendingRun;
    expect(finishedRun).toEqual(expect.objectContaining({ status: "cancelled", source: "one-shot", files: [] }));
    expect(mocks.deleteFiles).toHaveBeenCalledWith([expect.stringContaining(activeRunId!)]);
    expect(backup.runs.value.find((run) => run.id === activeRunId)).toEqual(expect.objectContaining({ status: "cancelled", files: [] }));
  });
});
