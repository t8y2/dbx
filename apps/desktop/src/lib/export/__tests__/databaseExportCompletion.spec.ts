import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDatabaseExportUntilTerminal, runWithDatabaseBackupSnapshot } from "../databaseExport";
import { SnapshotCompletionError } from "../snapshotCompletion";
import type { DatabaseExportRequest, ExportProgress } from "@/lib/backend/api";
const mocks = vi.hoisted(() => ({ export: vi.fn(), begin: vi.fn(), rollback: vi.fn() }));
vi.mock("@/lib/backend/api.ts", () => ({ exportDatabaseSql: mocks.export, beginDatabaseBackupSnapshot: mocks.begin, rollbackManualTransaction: mocks.rollback }));
const request = { exportId: "export-1", connectionId: "mysql-1", database: "app", filePath: "app.sql" } as DatabaseExportRequest;
const done: ExportProgress = { exportId: "export-1", currentObject: "T", objectIndex: 1, totalObjects: 1, rowsExported: 7, totalRows: 7, status: "Done", error: null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.begin.mockResolvedValue({ sessionId: "snapshot-1" });
  mocks.rollback.mockReset().mockResolvedValue(undefined);
});
describe("native queued database export completion", () => {
  it("waits for the terminal event after the actual native API acknowledges startup", async () => {
    let progress!: (value: ExportProgress) => void;
    mocks.export.mockImplementationOnce(async (_request, callback) => {
      progress = callback;
    });
    let settled = false;
    const pending = runDatabaseExportUntilTerminal(request, vi.fn(), true).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    progress(done);
    expect(await pending).toEqual(done);
  });
  it("waits for the actual invoke after terminal progress", async () => {
    const native = deferred<void>();
    mocks.export.mockImplementationOnce((_request, progress) => {
      progress(done);
      return native.promise;
    });
    let settled = false;
    const pending = runDatabaseExportUntilTerminal(request, vi.fn(), true).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    native.resolve();
    expect(await pending).toEqual(done);
  });
  it.each(["Done", "Error", "Cancelled"] as const)("preserves confirmed %s terminal evidence despite a subsequent invoke rejection", async (status) => {
    const terminal = { ...done, status, error: status === "Error" ? "export failed" : null };
    mocks.export.mockImplementationOnce(async (_request, progress) => {
      progress(terminal);
      throw new Error("invoke reply lost");
    });
    const pending = runDatabaseExportUntilTerminal(request, vi.fn(), true);
    if (status === "Error") await expect(pending).rejects.toMatchObject({ status: "failed", message: "export failed" });
    else expect(await pending).toEqual(terminal);
  });
  it("does not infer completion from an invoke rejection without terminal evidence", async () => {
    mocks.export.mockRejectedValueOnce(new Error("invoke reply lost"));
    await expect(runDatabaseExportUntilTerminal(request, vi.fn(), true)).rejects.toMatchObject({ status: "unknown" });
  });
  it("classifies a confirmed pre-invoke failure as failed instead of unknown", async () => {
    mocks.export.mockRejectedValueOnce(new SnapshotCompletionError("failed", "listener unavailable"));
    await expect(runDatabaseExportUntilTerminal(request, vi.fn(), true)).rejects.toMatchObject({ status: "failed", message: "listener unavailable" });
  });
  it("preserves the native cleanup-unknown outcome", async () => {
    mocks.export.mockImplementationOnce(async (_request, progress) => {
      progress({ ...done, status: "Unknown", error: "session close unknown" });
    });
    await expect(runDatabaseExportUntilTerminal(request, vi.fn(), true)).rejects.toMatchObject({ status: "unknown", message: "session close unknown" });
  });
  it("keeps the old progress-based completion contract by default", async () => {
    const native = deferred<void>();
    mocks.export.mockImplementationOnce((_request, progress) => {
      progress(done);
      return native.promise;
    });
    expect(await runDatabaseExportUntilTerminal(request, vi.fn())).toEqual(done);
    native.resolve();
  });
  it("holds successful snapshot work until rollback actually returns", async () => {
    const rollback = deferred<void>();
    mocks.rollback.mockReturnValueOnce(rollback.promise);
    let settled = false;
    const pending = runWithDatabaseBackupSnapshot({ connectionId: "mysql-1", database: "app", enabled: true, reportCompletion: true }, async () => done).then((value) => {
      settled = true;
      return value;
    });
    await vi.waitFor(() => expect(mocks.rollback).toHaveBeenCalledWith("snapshot-1"));
    expect(settled).toBe(false);
    rollback.resolve();
    expect(await pending).toEqual(done);
  });
  it.each(["success", "failure"] as const)("reports rollback failure as unknown after operation %s", async (outcome) => {
    mocks.rollback.mockRejectedValueOnce(new Error("rollback reply lost"));
    await expect(
      runWithDatabaseBackupSnapshot({ connectionId: "mysql-1", database: "app", enabled: true, reportCompletion: true }, async () => {
        if (outcome === "failure") throw new SnapshotCompletionError("failed", "export failed");
        return done;
      }),
    ).rejects.toMatchObject({ status: "unknown", message: "rollback reply lost" });
  });
  it("preserves an earlier unknown even if snapshot cleanup also fails", async () => {
    mocks.rollback.mockRejectedValueOnce(new Error("rollback reply lost"));
    const unknown = new SnapshotCompletionError("unknown", "export reply lost");
    await expect(
      runWithDatabaseBackupSnapshot({ connectionId: "mysql-1", database: "app", enabled: true, reportCompletion: true }, async () => {
        throw unknown;
      }),
    ).rejects.toBe(unknown);
  });
  it("keeps the old cleanup suppression contract by default", async () => {
    mocks.rollback.mockRejectedValueOnce(new Error("rollback reply lost"));
    const failed = new Error("export failed");
    await expect(
      runWithDatabaseBackupSnapshot({ connectionId: "mysql-1", database: "app", enabled: true }, async () => {
        throw failed;
      }),
    ).rejects.toBe(failed);
  });
});
