import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test, vi } from "vitest";

const { beginDatabaseBackupSnapshot, exportDatabaseSql, rollbackManualTransaction } = vi.hoisted(() => ({
  beginDatabaseBackupSnapshot: vi.fn(),
  exportDatabaseSql: vi.fn(),
  rollbackManualTransaction: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  beginDatabaseBackupSnapshot,
  exportDatabaseSql,
  rollbackManualTransaction,
}));

import { runDatabaseExportUntilTerminal, runWithDatabaseBackupSnapshot, shouldUseDatabaseBackupSnapshot } from "../../apps/desktop/src/lib/export/databaseExport.ts";

beforeEach(() => {
  beginDatabaseBackupSnapshot.mockReset();
  exportDatabaseSql.mockReset();
  rollbackManualTransaction.mockReset();
  beginDatabaseBackupSnapshot.mockResolvedValue({ sessionId: "snapshot-1" });
  rollbackManualTransaction.mockResolvedValue({});
});

test("database export snapshots are limited to supported desktop data exports", () => {
  assert.equal(shouldUseDatabaseBackupSnapshot("mysql", true, true), true);
  assert.equal(shouldUseDatabaseBackupSnapshot("postgres", true, true), true);
  assert.equal(shouldUseDatabaseBackupSnapshot("oracle", true, true), false);
  assert.equal(shouldUseDatabaseBackupSnapshot("sqlserver", true, true), false);
  assert.equal(shouldUseDatabaseBackupSnapshot("mysql", false, true), false);
  assert.equal(shouldUseDatabaseBackupSnapshot("postgres", true, false), false);
});

test("database export waits for terminal progress before releasing its snapshot", async () => {
  let emitProgress: ((progress: any) => void) | undefined;
  exportDatabaseSql.mockImplementation(async (_request, onProgress) => {
    emitProgress = onProgress;
  });

  const operation = runDatabaseExportUntilTerminal({ exportId: "export-1" } as any, () => {});
  let settled = false;
  void operation.then(() => {
    settled = true;
  });
  await Promise.resolve();

  assert.equal(settled, false);
  emitProgress?.({ exportId: "export-1", status: "Running" });
  await Promise.resolve();
  assert.equal(settled, false);

  emitProgress?.({ exportId: "export-1", status: "Done" });
  assert.equal((await operation).status, "Done");
});

test("single database export holds its snapshot until terminal progress", () => {
  const source = readFileSync("apps/desktop/src/components/export/DatabaseExportDialog.vue", "utf8");
  const singleExport = source.slice(source.indexOf("async function startExport()"), source.indexOf("async function startAllDatabasesExport()"));

  assert.match(singleExport, /return runDatabaseExportUntilTerminal\(request,/);
  assert.doesNotMatch(singleExport, /await api\.exportDatabaseSql\(request,/);
});

test("database export snapshot is released after success", async () => {
  const operation = vi.fn(async (sessionId: string | undefined) => `done:${sessionId}`);

  const result = await runWithDatabaseBackupSnapshot({ connectionId: "conn-1", database: "app", enabled: true }, operation);

  assert.equal(result, "done:snapshot-1");
  assert.deepEqual(operation.mock.calls, [["snapshot-1"]]);
  assert.deepEqual(rollbackManualTransaction.mock.calls, [["snapshot-1"]]);
});

test("database export snapshot is released without masking an export error", async () => {
  const exportError = new Error("export failed");
  const cleanupError = new Error("cleanup failed");
  rollbackManualTransaction.mockRejectedValue(cleanupError);

  await assert.rejects(
    runWithDatabaseBackupSnapshot({ connectionId: "conn-1", database: "app", enabled: true }, async () => {
      throw exportError;
    }),
    exportError,
  );

  assert.deepEqual(rollbackManualTransaction.mock.calls, [["snapshot-1"]]);
});

test("database export snapshot is released after cancellation", async () => {
  const cleanupError = new Error("cleanup failed");
  rollbackManualTransaction.mockRejectedValue(cleanupError);

  const result = await runWithDatabaseBackupSnapshot(
    { connectionId: "conn-1", database: "app", enabled: true },
    async () => ({ status: "Cancelled" as const }),
    (terminal) => terminal.status === "Done",
  );

  assert.equal(result.status, "Cancelled");
  assert.deepEqual(rollbackManualTransaction.mock.calls, [["snapshot-1"]]);
});

test("database export snapshot cleanup failure is reported after success", async () => {
  const cleanupError = new Error("cleanup failed");
  rollbackManualTransaction.mockRejectedValue(cleanupError);

  await assert.rejects(
    runWithDatabaseBackupSnapshot({ connectionId: "conn-1", database: "app", enabled: true }, async () => "done"),
    cleanupError,
  );
});
