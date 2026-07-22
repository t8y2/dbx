import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferProgress, TransferRequest } from "@/lib/backend/api";

vi.mock("@/lib/backend/api", () => ({
  startTransfer: vi.fn(),
  cancelTransfer: vi.fn(),
  cancelDatabaseExport: vi.fn(),
  cancelSqlFileExecution: vi.fn(),
  cancelTableExport: vi.fn(),
}));

import * as api from "@/lib/backend/api";
import { formatDataTransferDuration, useExportTracker } from "@/composables/useExportTracker";

let now = 0;

function transferRequest(transferId: string, tables = ["users"]): TransferRequest {
  return {
    transferId,
    sourceConnectionId: "source",
    sourceDatabase: "source_db",
    sourceSchema: "public",
    targetConnectionId: "target",
    targetDatabase: "target_db",
    targetSchema: "public",
    tables,
    createTable: true,
    mode: "append",
    targetTableNameCase: "preserve",
    batchSize: 1000,
  };
}

function transferProgress(transferId: string, status: TransferProgress["status"], terminal = true): TransferProgress {
  return {
    transferId,
    table: "users",
    tableIndex: 1,
    totalTables: 1,
    rowsTransferred: 10,
    totalRows: 10,
    status,
    error: status === "error" ? "transfer failed" : null,
    terminal,
  };
}

function resetTracker() {
  const tracker = useExportTracker();
  for (const task of tracker.tasks.value) tracker.removeTask(task.exportId);
}

beforeEach(() => {
  now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.clearAllMocks();
  resetTracker();
});

afterEach(() => {
  resetTracker();
  vi.restoreAllMocks();
});

describe("data transfer task duration", () => {
  it("freezes the first successful terminal duration", () => {
    const tracker = useExportTracker();
    now = 1_000;
    const task = tracker.addDataTransferTask("success", "users", 1);

    now = 4_500;
    tracker.updateDataTransferTask(task.exportId, transferProgress(task.exportId, "done"));
    now = 9_000;
    tracker.updateDataTransferTask(task.exportId, transferProgress(task.exportId, "done"));

    expect(task.startedAt).toBe(1_000);
    expect(task.finishedAt).toBe(4_500);
    expect(task.status).toBe("Done");
  });

  it.each([
    ["error", "Error"],
    ["cancelled", "Cancelled"],
  ] as const)("freezes %s terminal duration", (status, expectedStatus) => {
    const tracker = useExportTracker();
    now = 2_000;
    const task = tracker.addDataTransferTask(status, "users", 1);

    now = 7_250;
    tracker.updateDataTransferTask(task.exportId, transferProgress(task.exportId, status));

    expect(task.finishedAt! - task.startedAt!).toBe(5_250);
    expect(task.status).toBe(expectedStatus);
  });

  it("tracks concurrent transfer durations independently", () => {
    const tracker = useExportTracker();
    now = 1_000;
    const first = tracker.addDataTransferTask("first", "first", 1);
    now = 2_000;
    const second = tracker.addDataTransferTask("second", "second", 1);

    now = 5_000;
    tracker.updateDataTransferTask(first.exportId, transferProgress(first.exportId, "done"));
    now = 8_000;
    tracker.updateDataTransferTask(second.exportId, transferProgress(second.exportId, "cancelled"));

    expect(first.finishedAt! - first.startedAt!).toBe(4_000);
    expect(second.finishedAt! - second.startedAt!).toBe(6_000);
  });

  it("records an immediate start failure as a terminal duration", async () => {
    vi.mocked(api.startTransfer).mockRejectedValueOnce(new Error("start failed"));
    const tracker = useExportTracker();
    now = 10_000;
    const task = tracker.startDataTransferTask(transferRequest("start-failure"), "users");
    now = 10_025;

    await vi.waitFor(() => expect(task.status).toBe("Error"));

    expect(task.finishedAt! - task.startedAt!).toBe(25);
    expect(task.errorMessage).toBe("start failed");
  });

  it("freezes an overlapping transfer failure without starting another request", async () => {
    let resolveFirst!: () => void;
    vi.mocked(api.startTransfer).mockImplementationOnce(() => new Promise<void>((resolve) => (resolveFirst = resolve)));
    const tracker = useExportTracker();
    now = 100;
    tracker.startDataTransferTask(transferRequest("active"), "active");
    now = 130;
    const overlapping = tracker.startDataTransferTask(transferRequest("overlap"), "overlap");

    expect(overlapping.status).toBe("Error");
    expect(overlapping.finishedAt! - overlapping.startedAt!).toBe(0);
    expect(api.startTransfer).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.resolve();
  });

  it("keeps SQL-file backend elapsed time unchanged", () => {
    const tracker = useExportTracker();
    const task = tracker.addSqlFileTask("sql", "script.sql", "/tmp/script.sql");

    tracker.updateSqlFileTask(task.exportId, {
      executionId: task.exportId,
      status: "done",
      statementIndex: 1,
      successCount: 1,
      failureCount: 0,
      affectedRows: 3,
      elapsedMs: 1_234,
      statementSummary: "SELECT 1",
      error: null,
    });

    expect(task.elapsedMs).toBe(1_234);
    expect(task.startedAt).toBeUndefined();
    expect(task.finishedAt).toBeUndefined();
  });
});

describe("formatDataTransferDuration", () => {
  it("formats millisecond, second, minute, and hour boundaries", () => {
    expect(formatDataTransferDuration(Number.NaN)).toBe("0 ms");
    expect(formatDataTransferDuration(-1)).toBe("0 ms");
    expect(formatDataTransferDuration(999)).toBe("999 ms");
    expect(formatDataTransferDuration(1_000)).toBe("1.0 s");
    expect(formatDataTransferDuration(59_999)).toBe("59.9 s");
    expect(formatDataTransferDuration(60_000)).toBe("1m 0s");
    expect(formatDataTransferDuration(60_999)).toBe("1m 0s");
    expect(formatDataTransferDuration(3_599_999)).toBe("59m 59s");
    expect(formatDataTransferDuration(3_600_000)).toBe("1h 0m 0s");
    expect(formatDataTransferDuration(3_661_000)).toBe("1h 1m 1s");
  });
});
