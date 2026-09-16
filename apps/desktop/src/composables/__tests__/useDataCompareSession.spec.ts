import { strict as assert } from "node:assert";
import { beforeEach, test, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  buildDataCompareSyncPlan: vi.fn(),
  getColumns: vi.fn(),
  prepareDataCompareFromTables: vi.fn(),
  prepareDataCompareMissingTarget: vi.fn(),
}));

const openMock = vi.hoisted(() => vi.fn());
const trackerMock = vi.hoisted(() => ({
  addDataCompareTask: vi.fn(),
  updateCompareTask: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => apiMock);
vi.mock("@/composables/useDialogSources", () => ({ openDataCompareSession: openMock }));
vi.mock("@/composables/useExportTracker", () => ({ useExportTracker: () => trackerMock }));

const { startDataCompareSession } = await import("../useDataCompareSession.ts");

test("runs a data compare session independently of the dialog and retains its result", async () => {
  apiMock.getColumns.mockResolvedValue([
    { name: "id", is_primary_key: true },
    { name: "name", is_primary_key: false },
  ]);
  apiMock.prepareDataCompareFromTables.mockResolvedValue({
    result: {
      added: [{ key: "1", keyValues: { id: 1 }, values: { id: 1, name: "new" } }],
      removed: [],
      modified: [],
    },
    syncStatements: ["INSERT INTO users (id, name) VALUES (1, 'new')"],
    syncSql: "INSERT INTO users (id, name) VALUES (1, 'new')",
    preSyncStatements: [],
    sourceRowCount: 1,
    targetRowCount: 0,
    sourceTruncated: false,
    targetTruncated: false,
  });
  apiMock.buildDataCompareSyncPlan.mockResolvedValue({
    insertCount: 1,
    updateCount: 0,
    deleteCount: 0,
    statementCount: 1,
    syncStatements: ["INSERT"],
    syncSql: "INSERT",
  });

  const session = startDataCompareSession(
    {
      sourceConnectionId: "source",
      sourceDatabase: "app",
      sourceSchema: "public",
      sourceDatabases: ["app"],
      sourceSchemas: ["public"],
      sourceTables: ["users"],
      selectedSourceTables: ["users"],
      targetConnectionId: "target",
      targetDatabase: "warehouse",
      targetSchema: "public",
      targetDatabases: ["warehouse"],
      targetSchemas: ["public"],
      targetTables: ["users"],
      targetTable: "users",
      keyColumns: ["id"],
      label: "app → warehouse",
    },
    [{ sourceTable: "users", targetTable: "users" }],
    {
      ensureConnected: vi.fn().mockResolvedValue(undefined),
      getConfig: () => ({ db_type: "mysql" }),
    },
  );

  for (let attempt = 0; attempt < 20 && session.status === "running"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(session.status, "completed");
  assert.equal(session.batchResults.length, 1);
  assert.equal(session.batchResults[0]?.status, "different");
  assert.equal(session.batchResults[0]?.diff.added[0]?.selected, true);
  assert.equal(session.syncPlan.statementCount, 1);
  assert.equal(trackerMock.addDataCompareTask.mock.calls.length, 1);
  assert.equal(trackerMock.updateCompareTask.mock.calls.at(-1)?.[1].status, "Done");

  const onOpen = trackerMock.addDataCompareTask.mock.calls[0]?.[2] as (() => void) | undefined;
  onOpen?.();
  assert.equal(openMock.mock.calls.at(-1)?.[0], session.id);
});

beforeEach(() => {
  vi.clearAllMocks();
});
