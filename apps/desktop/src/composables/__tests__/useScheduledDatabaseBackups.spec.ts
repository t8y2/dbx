import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseBackupRun, DatabaseBackupSchedule } from "../../lib/backup/scheduledDatabaseBackup";
import type { DatabaseBackupSnapshot } from "../../lib/backup/backgroundDatabaseBackup";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  legacySchedules: vi.fn(() => []),
  legacyRuns: vi.fn(() => []),
  desktop: true,
  addTask: vi.fn(),
  updateTask: vi.fn(),
  cancelTask: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
}));
vi.mock("vue", async () => ({ ...(await vi.importActual("vue")), onMounted: vi.fn(), onUnmounted: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ databaseBackupCommand: mocks.command }));
vi.mock("@/lib/backend/debugLog", () => ({ appendDebugLog: vi.fn() }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => mocks.desktop }));
vi.mock("@/lib/backup/scheduledDatabaseBackup", () => ({ readDatabaseBackupSchedules: mocks.legacySchedules, readDatabaseBackupRuns: mocks.legacyRuns }));
vi.mock("@/composables/useExportTracker", () => ({
  useExportTracker: () => ({
    addDatabaseExportTask: mocks.addTask,
    updateDatabaseExportTask: mocks.updateTask,
    markDatabaseExportTaskCancelling: mocks.cancelTask,
    registerTaskCancelHandler: mocks.register,
    unregisterTaskCancelHandler: mocks.unregister,
  }),
}));

let snapshot: DatabaseBackupSnapshot;
function run(status: DatabaseBackupRun["status"] = "running"): DatabaseBackupRun {
  return { id: "run-1", scheduleId: "schedule-1", scheduleName: "Daily", connectionId: "mysql", connectionName: "Local", destinationDirectory: "/backups", source: "scheduled", trigger: "manual", status, startedAt: "2026-09-12T00:00:00Z", files: [], progressPercent: 45 };
}
async function create() {
  return (await import("../useScheduledDatabaseBackups")).useScheduledDatabaseBackups();
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.desktop = true;
  snapshot = { schedules: [], runs: [], migrated: true, heartbeat: "2026-09-12T00:00:00Z", destinationRoot: null };
  mocks.command.mockImplementation(async (command) => (command.action === "snapshot" ? structuredClone(snapshot) : null));
});

describe("backend-owned scheduled database backups", () => {
  it("reconnects to running backups without starting another export", async () => {
    snapshot.runs = [run()];
    const backups = await create();
    await backups.processDueSchedules();
    await backups.processDueSchedules();
    expect(backups.activeRunIds.has("run-1")).toBe(true);
    expect(backups.activeScheduleIds.has("schedule-1")).toBe(true);
    expect(mocks.addTask).toHaveBeenCalledTimes(1);
    expect(mocks.command.mock.calls.every(([c]) => c.action === "snapshot")).toBe(true);
    expect(mocks.updateTask).toHaveBeenLastCalledWith("run-1", expect.objectContaining({ status: "Running", overallPercent: 45 }));
  });

  it("reflects completion from a worker that runs independently of the UI", async () => {
    snapshot.runs = [run()];
    const backups = await create();
    await backups.processDueSchedules();
    snapshot.runs[0] = { ...run("success"), progressPercent: 100 };
    await backups.processDueSchedules();
    expect(backups.activeRunIds.size).toBe(0);
    expect(backups.activeScheduleIds.size).toBe(0);
    expect(mocks.updateTask).toHaveBeenLastCalledWith("run-1", expect.objectContaining({ status: "Done", overallPercent: 100 }));
  });

  it("waits for durable cancellation acceptance before showing cancellation", async () => {
    snapshot.runs = [run()];
    const backups = await create();
    await backups.processDueSchedules();
    mocks.command.mockRejectedValueOnce(new Error("offline"));
    await expect(backups.cancelRun("run-1")).rejects.toThrow("offline");
    expect(backups.cancellingRunIds.size).toBe(0);
    mocks.command.mockResolvedValueOnce(true);
    expect(await backups.cancelRun("run-1")).toBe(true);
    expect(backups.cancellingRunIds.has("run-1")).toBe(true);
    expect(mocks.command).toHaveBeenLastCalledWith({ action: "cancel", id: "run-1" });
  });

  it("deletes by server record IDs, never by client supplied file paths", async () => {
    snapshot.runs = [run("success")];
    const backups = await create();
    await backups.processDueSchedules();
    await backups.deleteRuns(["run-1"]);
    expect(mocks.command).toHaveBeenCalledWith({ action: "deleteRuns", ids: ["run-1"] });
  });

  it("preserves optimistic concurrency timestamps and saved time zones", async () => {
    const schedule = { id: "schedule-1", name: "Daily", timeZone: "Asia/Tokyo", updatedAt: "2026-09-01T00:00:00Z" } as DatabaseBackupSchedule;
    const backups = await create();
    await backups.saveSchedule(schedule);
    expect(mocks.command).toHaveBeenCalledWith({ action: "save", schedule });
  });

  it("does not overwrite local state after a failed save", async () => {
    snapshot.schedules = [{ id: "schedule-1", name: "Original" } as DatabaseBackupSchedule];
    const backups = await create();
    await backups.processDueSchedules();
    mocks.command.mockRejectedValueOnce(new Error("schedule changed"));
    await expect(backups.saveSchedule({ ...snapshot.schedules[0], name: "New" })).rejects.toThrow("schedule changed");
    expect(backups.schedules.value[0].name).toBe("Original");
  });

  it("reloads after a save even when an older poll finishes later", async () => {
    const backups = await create();
    const oldSnapshot = structuredClone(snapshot);
    let release!: (value: DatabaseBackupSnapshot) => void;
    mocks.command.mockImplementationOnce(
      () =>
        new Promise<DatabaseBackupSnapshot>((resolve) => {
          release = resolve;
        }),
    );
    const polling = backups.processDueSchedules();
    const schedule = { id: "schedule-1", name: "New", timeZone: "Asia/Shanghai" } as DatabaseBackupSchedule;
    mocks.command.mockImplementation(async (command) => {
      if (command.action === "save") {
        snapshot.schedules = [schedule];
        return schedule;
      }
      return structuredClone(snapshot);
    });
    const saving = backups.saveSchedule(schedule);
    release(oldSnapshot);
    await polling;
    await saving;
    expect(backups.schedules.value).toEqual([schedule]);
    expect(mocks.command.mock.calls.filter(([command]) => command.action === "snapshot")).toHaveLength(2);
  });

  it("does not lose a newly queued run to a stale in-flight snapshot", async () => {
    const backups = await create();
    const oldSnapshot = structuredClone(snapshot);
    let release!: (value: DatabaseBackupSnapshot) => void;
    mocks.command.mockImplementationOnce(
      () =>
        new Promise<DatabaseBackupSnapshot>((resolve) => {
          release = resolve;
        }),
    );
    const polling = backups.processDueSchedules();
    mocks.command.mockImplementation(async (command) => {
      if (command.action === "run") {
        snapshot.runs = [run("success")];
        return run();
      }
      return structuredClone(snapshot);
    });
    const running = backups.runSchedule("schedule-1");
    release(oldSnapshot);
    await polling;
    expect(await running).toEqual(run("success"));
  });

  it("marks migration only after the backend accepts it", async () => {
    snapshot.migrated = false;
    const backups = await create();
    mocks.command.mockImplementation(async (command) => {
      if (command.action === "migrate") throw new Error("database locked");
      return structuredClone(snapshot);
    });
    await expect(backups.processDueSchedules()).rejects.toThrow("database locked");
    expect(mocks.legacySchedules).toHaveBeenCalledTimes(1);
    expect(backups.error.value).toBe("database locked");
    mocks.command.mockImplementation(async (command) => {
      if (command.action === "migrate") {
        snapshot.migrated = true;
        return null;
      }
      return structuredClone(snapshot);
    });
    await backups.processDueSchedules();
    await backups.processDueSchedules();
    expect(mocks.legacySchedules).toHaveBeenCalledTimes(2);
  });

  it("never migrates browser-local paths into a server", async () => {
    mocks.desktop = false;
    snapshot.migrated = false;
    const backups = await create();
    await backups.processDueSchedules();
    expect(mocks.legacySchedules).not.toHaveBeenCalled();
    expect(mocks.legacyRuns).not.toHaveBeenCalled();
    expect(mocks.command).toHaveBeenCalledWith({ action: "migrate", migration: { schedules: [], runs: [] } });
  });
});
