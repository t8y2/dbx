import { beforeEach, expect, it, vi } from "vitest";
import { exportDatabaseSql, exportMongodbQuery, exportSnapshotResult, readLargeValueChunk, startTableExport, startQueryResultExport } from "../tauri";
import { SnapshotCompletionError } from "@/lib/export/snapshotCompletion";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

const context = { connectionId: "original", database: "APP", valueRef: "captured" };
const request = { context, format: "json" as const, columns: ["C"], rows: [["preview"]], cells: [{ rowIndex: 0, columnIndex: 0, valueRef: "captured" }] };

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.listen.mockReset();
});

it.each([startTableExport, startQueryResultExport, exportDatabaseSql])("reports only pre-invoke listener failure as confirmed not-started", async (start) => {
  mocks.listen.mockRejectedValueOnce(new Error("listener unavailable"));
  await expect(start({ exportId: "not-started" } as never, vi.fn(), true)).rejects.toEqual(new SnapshotCompletionError("failed", "listener unavailable"));
  expect(mocks.invoke).not.toHaveBeenCalled();
  mocks.listen.mockResolvedValueOnce(vi.fn());
  mocks.invoke.mockRejectedValueOnce(new Error("invoke reply lost"));
  await expect(start({ exportId: "unknown" } as never, vi.fn(), true)).rejects.not.toBeInstanceOf(SnapshotCompletionError);
});

it("preserves default export adapter error wrapping when listener setup fails", async () => {
  mocks.listen.mockRejectedValueOnce(new Error("listener unavailable"));
  await expect(startTableExport({ exportId: "old" } as never, vi.fn())).rejects.not.toBeInstanceOf(SnapshotCompletionError);
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("keeps native cleanup-unknown progress from becoming a releasable table terminal", async () => {
  let receive!: (event: { payload: unknown }) => void;
  const unlisten = vi.fn();
  mocks.listen.mockImplementationOnce(async (_name, callback) => {
    receive = callback;
    return unlisten;
  });
  mocks.invoke.mockResolvedValueOnce(undefined);
  const progress = vi.fn();
  const pending = startTableExport({ exportId: "cleanup-unknown" } as never, progress, true);
  await Promise.resolve();
  await Promise.resolve();
  receive({ payload: { exportId: "cleanup-unknown", tableName: "T", rowsExported: 0, totalRows: null, status: "Unknown", errorMessage: "session close unknown" } });
  await expect(pending).rejects.toThrow("session close unknown");
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ status: "Unknown" }));
  expect(unlisten).toHaveBeenCalledOnce();
});

it("keeps default native payloads and the existing post-invoke abort behavior", async () => {
  const controller = new AbortController();
  mocks.invoke.mockImplementationOnce(async () => {
    controller.abort(new Error("local abort"));
  });
  await expect(exportSnapshotResult(request, "original.json", controller.signal)).rejects.toThrow("local abort");
  expect(mocks.invoke).toHaveBeenLastCalledWith("export_snapshot_result", { request, filePath: "original.json" });
  mocks.invoke.mockResolvedValueOnce({ data: "old chunk" });
  await expect(readLargeValueChunk(context)).resolves.toEqual({ data: "old chunk" });
  expect(mocks.invoke).toHaveBeenLastCalledWith("read_large_value_chunk", { request: context });
});

it("preserves confirmed persisted success when cancellation arrives late", async () => {
  const controller = new AbortController();
  mocks.invoke.mockImplementationOnce(async () => {
    controller.abort(new Error("late abort"));
    return { status: "succeeded", value: null };
  });
  await expect(exportSnapshotResult(request, "original.json", controller.signal, true)).resolves.toBeUndefined();
  expect(mocks.invoke).toHaveBeenLastCalledWith("export_snapshot_result", { request, filePath: "original.json", reportOutcome: true });
});

it.each(["failed", "cancelled", "unknown"] as const)("preserves the native %s evidence for reads and writes", async (status) => {
  mocks.invoke.mockResolvedValue({ status, message: "original failure" });
  for (const operation of [() => readLargeValueChunk(context, true), () => exportSnapshotResult(request, "original.json", undefined, true)]) {
    await expect(operation()).rejects.toEqual(new SnapshotCompletionError(status, "original failure"));
  }
});

it("does not upgrade IPC rejection or an invalid envelope into completion evidence", async () => {
  const error = new Error("IPC lost");
  mocks.invoke.mockRejectedValueOnce(error);
  await expect(readLargeValueChunk(context, true)).rejects.toBe(error);
  mocks.invoke.mockResolvedValueOnce({ status: "failed" });
  await expect(exportSnapshotResult(request, "original.json", undefined, true)).rejects.not.toBeInstanceOf(SnapshotCompletionError);
});

it.each(["failed", "cancelled", "unknown"] as const)("unwraps Mongo %s only after the native invocation returns", async (status) => {
  let receive!: (event: { payload: unknown }) => void;
  mocks.listen.mockImplementationOnce(async (_name, callback) => {
    receive = callback;
    return vi.fn();
  });
  let complete!: (value: unknown) => void;
  mocks.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const request = { exportId: "mongo" } as never;
  const pending = exportMongodbQuery(request, vi.fn(), true);
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
  expect(mocks.invoke).toHaveBeenCalledWith("export_mongodb_query", { request, reportOutcome: true });
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  receive({ payload: { exportId: "mongo", status: "cancelled" } });
  await Promise.resolve();
  expect(settled).toBe(false);
  complete({ status, message: "actual completion" });
  await expect(pending).rejects.toEqual(new SnapshotCompletionError(status, "actual completion"));
});

it("keeps the default Mongo wire and distinguishes listener failure from invoke uncertainty", async () => {
  const request = { exportId: "mongo" } as never;
  const summary = { documentsExported: 2 };
  mocks.listen.mockResolvedValue(vi.fn());
  mocks.invoke.mockResolvedValueOnce(summary);
  await expect(exportMongodbQuery(request, vi.fn())).resolves.toEqual(summary);
  expect(mocks.invoke).toHaveBeenLastCalledWith("export_mongodb_query", { request });
  mocks.listen.mockRejectedValueOnce(new Error("listen failed"));
  await expect(exportMongodbQuery(request, vi.fn(), true)).rejects.toBeInstanceOf(SnapshotCompletionError);
  const error = new Error("IPC failed");
  mocks.invoke.mockRejectedValueOnce(error);
  await expect(exportMongodbQuery(request, vi.fn(), true)).rejects.toBe(error);
});
