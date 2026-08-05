import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const { beginDatabaseBackupSnapshot, rollbackManualTransaction } = vi.hoisted(() => ({
  beginDatabaseBackupSnapshot: vi.fn(),
  rollbackManualTransaction: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  beginDatabaseBackupSnapshot,
  rollbackManualTransaction,
}));

import { runWithDatabaseBackupSnapshot } from "../../apps/desktop/src/lib/export/databaseExport.ts";

beforeEach(() => {
  beginDatabaseBackupSnapshot.mockReset();
  rollbackManualTransaction.mockReset();
  beginDatabaseBackupSnapshot.mockResolvedValue({ sessionId: "snapshot-1" });
  rollbackManualTransaction.mockResolvedValue({});
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
