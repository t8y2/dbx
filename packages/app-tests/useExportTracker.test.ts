import { strict as assert } from "node:assert";
import { test, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  cancelDatabaseExport: vi.fn(),
  cancelSqlFileExecution: vi.fn(),
  cancelTableExport: vi.fn(),
  cancelTransfer: vi.fn(),
  startTransfer: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => apiMock);

const { useExportTracker } = await import("../../apps/desktop/src/composables/useExportTracker.ts");

test("tracks database export progress and cancels through database export API", async () => {
  const tracker = useExportTracker();
  const task = tracker.addDatabaseExportTask("db-export-1", "app", "/tmp/app.sql");

  tracker.updateDatabaseExportTask("db-export-1", {
    exportId: "db-export-1",
    currentObject: "users",
    objectIndex: 2,
    totalObjects: 5,
    rowsExported: 120,
    totalRows: null,
    status: "Running",
    error: null,
  });

  assert.equal(task.kind, "database-export");
  assert.equal(task.tableName, "users");
  assert.equal(task.objectIndex, 2);
  assert.equal(task.totalObjects, 5);
  assert.equal(tracker.activeCount.value, 1);

  await tracker.cancelTask("db-export-1");
  assert.equal(apiMock.cancelDatabaseExport.mock.calls[0][0], "db-export-1");

  tracker.clearFinished();
  assert.equal(
    tracker.tasks.value.some((item) => item.exportId === "db-export-1"),
    true,
  );
});

test("tracks SQL file progress and clears terminal tasks", () => {
  const tracker = useExportTracker();
  const task = tracker.addSqlFileTask("sql-1", "init.sql", "/tmp/init.sql");

  tracker.updateSqlFileTask("sql-1", {
    executionId: "sql-1",
    status: "statementDone",
    statementIndex: 3,
    successCount: 2,
    failureCount: 1,
    affectedRows: 12,
    elapsedMs: 1500,
    statementSummary: "insert into users...",
    error: null,
  });

  assert.equal(task.kind, "sql-file");
  assert.equal(task.status, "Running");
  assert.equal(task.rowsExported, 3);
  assert.equal(task.totalRows, 3);
  assert.equal(task.affectedRows, 12);

  tracker.updateSqlFileTask("sql-1", {
    executionId: "sql-1",
    status: "done",
    statementIndex: 3,
    successCount: 3,
    failureCount: 0,
    affectedRows: 16,
    elapsedMs: 2000,
    statementSummary: "",
    error: null,
  });

  assert.equal(task.status, "Done");
  tracker.clearFinished();
  assert.equal(
    tracker.tasks.value.some((item) => item.exportId === "sql-1"),
    false,
  );
});

test("keeps the legacy table export task API and routes cancel to table export API", async () => {
  const tracker = useExportTracker();
  const task = tracker.addTask("orders", "csv", "/tmp/orders.csv");

  tracker.updateTableExportTask(task.exportId, {
    exportId: task.exportId,
    tableName: "orders",
    rowsExported: 10,
    totalRows: 20,
    status: "Writing",
    errorMessage: null,
  });

  assert.equal(task.kind, "table-export");
  assert.equal(task.status, "Writing");
  assert.equal(task.rowsExported, 10);

  await tracker.cancelTask(task.exportId);
  assert.equal(apiMock.cancelTableExport.mock.calls[0][0], task.exportId);
});

test("tracks data transfer progress and routes cancel to transfer API", async () => {
  const tracker = useExportTracker();
  const task = tracker.addDataTransferTask("transfer-1", "source → target", 4);

  tracker.updateDataTransferTask("transfer-1", {
    transferId: "transfer-1",
    table: "users",
    tableIndex: 2,
    totalTables: 4,
    rowsTransferred: 250,
    totalRows: 500,
    status: "running",
    error: null,
    terminal: false,
  });

  assert.equal(task.kind, "data-transfer");
  assert.equal(task.currentTable, "users");
  assert.equal(task.tableIndex, 2);
  assert.equal(task.totalTables, 4);
  assert.equal(task.rowsExported, 250);
  assert.equal(task.totalRows, 500);
  assert.equal(task.status, "Running");

  await tracker.cancelTask("transfer-1");
  assert.equal(apiMock.cancelTransfer.mock.calls[0][0], "transfer-1");
});

test("keeps data transfer active after a non-terminal table error", () => {
  const tracker = useExportTracker();
  const task = tracker.addDataTransferTask("transfer-error-1", "source → target", 2);

  tracker.updateDataTransferTask("transfer-error-1", {
    transferId: "transfer-error-1",
    table: "users",
    tableIndex: 0,
    totalTables: 2,
    rowsTransferred: 0,
    totalRows: null,
    status: "error",
    error: "permission denied",
    terminal: false,
  });

  assert.equal(task.status, "Running");
  assert.equal(task.errorMessage, "permission denied");

  tracker.clearFinished();
  assert.equal(
    tracker.tasks.value.some((item) => item.exportId === "transfer-error-1"),
    true,
  );

  tracker.updateDataTransferTask("transfer-error-1", {
    transferId: "transfer-error-1",
    table: "orders",
    tableIndex: 1,
    totalTables: 2,
    rowsTransferred: 10,
    totalRows: 50,
    status: "running",
    error: null,
    terminal: false,
  });

  assert.equal(task.status, "Running");
  assert.equal(task.errorMessage, "permission denied");
  assert.equal(task.currentTable, "orders");
  assert.equal(task.tableIndex, 1);
  assert.equal(task.rowsExported, 10);
});

test("marks data transfer failed only on terminal error summary", () => {
  const tracker = useExportTracker();
  const task = tracker.addDataTransferTask("transfer-terminal-error-1", "source → target", 2);

  tracker.updateDataTransferTask("transfer-terminal-error-1", {
    transferId: "transfer-terminal-error-1",
    table: "users",
    tableIndex: 0,
    totalTables: 2,
    rowsTransferred: 0,
    totalRows: null,
    status: "error",
    error: "permission denied",
    terminal: false,
  });
  tracker.updateDataTransferTask("transfer-terminal-error-1", {
    transferId: "transfer-terminal-error-1",
    table: "",
    tableIndex: 2,
    totalTables: 2,
    rowsTransferred: 0,
    totalRows: null,
    status: "error",
    error: "1 table(s) failed: users",
    terminal: true,
  });

  assert.equal(task.status, "Error");
  assert.equal(task.errorMessage, "1 table(s) failed: users");
  assert.equal(task.tableIndex, 2);
});

test("keeps data transfer row counts when terminal summary does not include rows", () => {
  const tracker = useExportTracker();
  const task = tracker.addDataTransferTask("transfer-rows-1", "source → target", 1);

  tracker.updateDataTransferTask("transfer-rows-1", {
    transferId: "transfer-rows-1",
    table: "users",
    tableIndex: 0,
    totalTables: 1,
    rowsTransferred: 200,
    totalRows: 200,
    status: "tableDone",
    error: null,
    terminal: false,
  });
  tracker.updateDataTransferTask("transfer-rows-1", {
    transferId: "transfer-rows-1",
    table: "",
    tableIndex: 1,
    totalTables: 1,
    rowsTransferred: 0,
    totalRows: null,
    status: "done",
    error: null,
    terminal: true,
  });

  assert.equal(task.status, "Done");
  assert.equal(task.rowsExported, 200);
  assert.equal(task.totalRows, 200);
  assert.equal(task.tableIndex, 1);
});

test("starts independent data transfer background tasks and routes progress by transfer id", async () => {
  const tracker = useExportTracker();
  const callbacks = new Map<string, (progress: any) => void>();
  const resolvers = new Map<string, () => void>();
  const onDone = vi.fn();

  apiMock.startTransfer.mockImplementation((request: any, onProgress: (progress: any) => void) => {
    callbacks.set(request.transferId, onProgress);
    return new Promise<void>((resolve) => resolvers.set(request.transferId, resolve));
  });

  const firstRequest = {
    transferId: "parallel-transfer-1",
    sourceConnectionId: "source-a",
    sourceDatabase: "app_a",
    sourceSchema: "public",
    targetConnectionId: "target-a",
    targetDatabase: "warehouse_a",
    targetSchema: "public",
    tables: ["users"],
    createTable: true,
    mode: "append",
    targetTableNameCase: "preserve",
    batchSize: 1000,
  };
  const secondRequest = {
    ...firstRequest,
    transferId: "parallel-transfer-2",
    sourceDatabase: "app_b",
    targetDatabase: "warehouse_b",
    tables: ["orders"],
  };

  const firstTask = tracker.startDataTransferTask(firstRequest, "app_a → warehouse_a", { onDone });
  const secondTask = tracker.startDataTransferTask(secondRequest, "app_b → warehouse_b");

  assert.equal(apiMock.startTransfer.mock.calls.at(-2)?.[0].transferId, "parallel-transfer-1");
  assert.equal(apiMock.startTransfer.mock.calls.at(-1)?.[0].transferId, "parallel-transfer-2");

  callbacks.get("parallel-transfer-2")?.({
    transferId: "parallel-transfer-2",
    table: "orders",
    tableIndex: 0,
    totalTables: 1,
    rowsTransferred: 40,
    totalRows: 100,
    status: "running",
    error: null,
    terminal: false,
  });
  callbacks.get("parallel-transfer-1")?.({
    transferId: "parallel-transfer-1",
    table: "users",
    tableIndex: 0,
    totalTables: 1,
    rowsTransferred: 10,
    totalRows: 50,
    status: "running",
    error: null,
    terminal: false,
  });

  assert.equal(firstTask.currentTable, "users");
  assert.equal(firstTask.rowsExported, 10);
  assert.equal(secondTask.currentTable, "orders");
  assert.equal(secondTask.rowsExported, 40);

  callbacks.get("parallel-transfer-1")?.({
    transferId: "parallel-transfer-1",
    table: "",
    tableIndex: 1,
    totalTables: 1,
    rowsTransferred: 50,
    totalRows: 50,
    status: "done",
    error: null,
    terminal: true,
  });
  resolvers.get("parallel-transfer-1")?.();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(firstTask.status, "Done");
  assert.equal(secondTask.status, "Running");
  assert.equal(onDone.mock.calls.length, 1);
});

test("blocks concurrent data transfers that write the same target table", () => {
  const tracker = useExportTracker();
  apiMock.startTransfer.mockImplementation(() => new Promise<void>(() => {}));

  const firstRequest = {
    transferId: "same-target-transfer-1",
    sourceConnectionId: "source-a",
    sourceDatabase: "app_a",
    sourceSchema: "public",
    targetConnectionId: "target-a",
    targetDatabase: "warehouse",
    targetSchema: "public",
    tables: ["users"],
    createTable: true,
    mode: "append",
    targetTableNameCase: "preserve",
    batchSize: 1000,
  };
  const secondRequest = {
    ...firstRequest,
    transferId: "same-target-transfer-2",
    sourceDatabase: "app_b",
  };

  const firstTask = tracker.startDataTransferTask(firstRequest, "app_a → warehouse");
  const secondTask = tracker.startDataTransferTask(secondRequest, "app_b → warehouse");

  assert.equal(firstTask.status, "Running");
  assert.equal(secondTask.status, "Error");
  assert.match(secondTask.errorMessage ?? "", /already running/);

  tracker.updateDataTransferTask("same-target-transfer-1", {
    transferId: "same-target-transfer-1",
    table: "",
    tableIndex: 1,
    totalTables: 1,
    rowsTransferred: 0,
    totalRows: null,
    status: "done",
    error: null,
    terminal: true,
  });
});
