import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";

const mocks = vi.hoisted(() => ({
  cancelQuery: vi.fn(),
  executeMultiWithProgress: vi.fn(),
  openDataGenerateSession: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  cancelDatabaseExport: vi.fn(),
  cancelQuery: mocks.cancelQuery,
  cancelSqlFileExecution: vi.fn(),
  cancelTableExport: vi.fn(),
  cancelTransfer: vi.fn(),
  executeMultiWithProgress: mocks.executeMultiWithProgress,
  startTransfer: vi.fn(),
}));

vi.mock("@/composables/useDialogSources", () => ({
  openDataGenerateSession: mocks.openDataGenerateSession,
}));

import { getDataGenerateSession, startDataGenerateSession } from "@/composables/useDataGenerateSession";
import { useExportTracker } from "@/composables/useExportTracker";

function successfulResult(): QueryResult[] {
  return [
    {
      columns: [],
      rows: [],
      affected_rows: 2,
      execution_time_ms: 1,
    },
  ];
}

function startSession() {
  return startDataGenerateSession(
    {
      connectionId: "connection-1",
      database: "app",
      prefillSchema: "public",
      databaseType: "postgres",
      label: "app.users",
      targets: [
        {
          tableName: "users",
          schema: "public",
          database: "app",
          targetRowCount: 2,
          isSample: false,
          columns: ["id"],
          rows: [[1], [2]],
          sql: "INSERT INTO users VALUES (1), (2);",
          statements: ["INSERT INTO users VALUES (1), (2);"],
          resolvedColumns: [
            {
              columnName: "id",
              dataType: "integer",
              rowCount: 2,
              generatorKey: "sequence",
              generatorParams: { startValue: 1, increment: 1 },
            },
          ],
        },
      ],
      options: {
        continueOnError: false,
        truncate: false,
        useTransaction: true,
        extendedInsert: true,
        timeoutSecs: 0,
        batchRows: 2,
      },
    },
    { invalidateMetadataCache: vi.fn() },
  );
}

function resetTracker() {
  const tracker = useExportTracker();
  for (const task of tracker.tasks.value) tracker.removeTask(task.exportId);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetTracker();
});

afterEach(() => {
  resetTracker();
});

describe("data generation background sessions", () => {
  it("continues outside the dialog, reopens from the task entry, and cleans up after completion", async () => {
    let finishBatch!: (result: QueryResult[]) => void;
    mocks.executeMultiWithProgress.mockImplementationOnce(
      () =>
        new Promise<QueryResult[]>((resolve) => {
          finishBatch = resolve;
        }),
    );

    const tracker = useExportTracker();
    const session = startSession();
    const task = tracker.tasks.value.find((candidate) => candidate.exportId === session.id)!;

    await vi.waitFor(() => expect(mocks.executeMultiWithProgress).toHaveBeenCalledOnce());
    expect(session.status).toBe("running");
    expect(task.status).toBe("Running");

    task.onOpen?.();
    expect(mocks.openDataGenerateSession).toHaveBeenCalledWith(session.id, {
      connectionId: "connection-1",
      database: "app",
      schema: "public",
      tableName: "users",
    });

    finishBatch(successfulResult());
    await vi.waitFor(() => expect(session.status).toBe("completed"));
    expect(task.status).toBe("Done");
    expect(task.rowsExported).toBe(2);
    expect(session.results).toEqual([{ table: "users", total: 2, ok: 2, err: 0, error: undefined, cancelled: undefined }]);

    tracker.removeTask(session.id);
    expect(getDataGenerateSession(session.id)).toBeUndefined();
  });

  it("keeps cancel separate from minimize and publishes the cancelled terminal state", async () => {
    let failBatch!: (error: Error) => void;
    mocks.executeMultiWithProgress.mockImplementationOnce(
      () =>
        new Promise<QueryResult[]>((_resolve, reject) => {
          failBatch = reject;
        }),
    );
    mocks.cancelQuery.mockResolvedValueOnce(true);

    const tracker = useExportTracker();
    const session = startSession();
    const task = tracker.tasks.value.find((candidate) => candidate.exportId === session.id)!;
    await vi.waitFor(() => expect(mocks.executeMultiWithProgress).toHaveBeenCalledOnce());

    await tracker.cancelTask(session.id);
    expect(mocks.cancelQuery).toHaveBeenCalledWith(session.id);
    expect(session.status).toBe("cancelling");
    expect(task.status).toBe("Cancelling");

    failBatch(new Error("Query canceled"));
    await vi.waitFor(() => expect(session.status).toBe("cancelled"));
    expect(task.status).toBe("Cancelled");
    expect(session.results[0]?.cancelled).toBe(true);
  });

  it("retains per-table failures in the resumable result", async () => {
    mocks.executeMultiWithProgress.mockResolvedValueOnce([
      {
        columns: ["Error"],
        rows: [["duplicate key"]],
        affected_rows: 0,
        execution_time_ms: 1,
        execution_error: true,
      } as QueryResult,
    ]);

    const tracker = useExportTracker();
    const session = startSession();
    const task = tracker.tasks.value.find((candidate) => candidate.exportId === session.id)!;

    await vi.waitFor(() => expect(session.status).toBe("completed"));
    expect(task.status).toBe("Error");
    expect(task.errorMessage).toBe("duplicate key");
    expect(session.results[0]).toMatchObject({ table: "users", ok: 0, err: 2, error: "duplicate key" });
  });
});
