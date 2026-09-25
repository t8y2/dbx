import { strict as assert } from "node:assert";
import { beforeEach, test, vi } from "vitest";
import type { ColumnInfo } from "@/types/database";
import type { DataCompareSession, DataCompareSessionConfig } from "../useDataCompareSession.ts";

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

const { normalizeKeyColumnOverrides, startDataCompareSession } = await import("../useDataCompareSession.ts");

function column(name: string, isPrimaryKey = false): ColumnInfo {
  return { name, data_type: "TEXT", is_nullable: true, column_default: null, is_primary_key: isPrimaryKey, extra: null };
}

const TABLES: Record<string, ColumnInfo[]> = {
  users: [column("user_id", true), column("email"), column("name")],
  orders: [column("tenant_id", true), column("order_id", true), column("amount")],
  payments: [column("payment_no", true), column("tenant_id"), column("amount")],
  logs: [column("category"), column("created_at")],
  legacy: [column("snid", true), column("username")],
};

function preparationFor(table: string) {
  return {
    result: { added: [{ key: "1", keyValues: { id: 1 }, values: { id: 1 } }], removed: [], modified: [] },
    syncStatements: [`INSERT INTO ${table} (id) VALUES (1)`],
    syncSql: `INSERT INTO ${table} (id) VALUES (1)`,
    preSyncStatements: [],
    sourceRowCount: 1,
    targetRowCount: 0,
    sourceTruncated: false,
    targetTruncated: false,
  };
}

function baseConfig(overrides: Partial<DataCompareSessionConfig> = {}): DataCompareSessionConfig {
  return {
    sourceConnectionId: "source",
    sourceDatabase: "app",
    sourceSchema: "public",
    sourceDatabases: ["app"],
    sourceSchemas: ["public"],
    sourceTables: Object.keys(TABLES),
    selectedSourceTables: [],
    targetConnectionId: "target",
    targetDatabase: "warehouse",
    targetSchema: "public",
    targetDatabases: ["warehouse"],
    targetSchemas: ["public"],
    targetTables: Object.keys(TABLES),
    targetTable: "",
    keyColumnsByTable: {},
    label: "app → warehouse",
    ...overrides,
  };
}

const dependencies = {
  ensureConnected: () => Promise.resolve(undefined),
  getConfig: () => ({ db_type: "mysql" as const }),
};

async function runSession(input: DataCompareSessionConfig, tasks: { sourceTable: string; targetTable: string }[]): Promise<DataCompareSession> {
  const session = startDataCompareSession(input, tasks, dependencies);
  for (let attempt = 0; attempt < 50 && session.status === "running"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return session;
}

function keyColumnsOf(call: number): string[] {
  return apiMock.prepareDataCompareFromTables.mock.calls[call]?.[0]?.keyColumns as string[];
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.getColumns.mockImplementation((_connectionId: string, _database: string, _schema: string, table: string) => Promise.resolve(TABLES[table] ?? []));
  apiMock.prepareDataCompareFromTables.mockImplementation((options: { targetTable: string }) => Promise.resolve(preparationFor(options.targetTable)));
  apiMock.buildDataCompareSyncPlan.mockResolvedValue({
    insertCount: 1,
    updateCount: 0,
    deleteCount: 0,
    statementCount: 1,
    syncStatements: ["INSERT"],
    syncSql: "INSERT",
  });
});

test("runs a data compare session independently of the dialog and retains its result", async () => {
  const session = await runSession(baseConfig({ selectedSourceTables: ["users"], targetTable: "users" }), [{ sourceTable: "users", targetTable: "users" }]);

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

test("infers the primary key of every table when no match columns are configured", async () => {
  const session = await runSession(baseConfig({ selectedSourceTables: ["users", "orders", "payments"] }), [
    { sourceTable: "users", targetTable: "users" },
    { sourceTable: "orders", targetTable: "orders" },
    { sourceTable: "payments", targetTable: "payments" },
  ]);

  assert.equal(session.status, "completed");
  assert.deepEqual(
    session.batchResults.map((result) => result.keyColumns),
    [["user_id"], ["tenant_id", "order_id"], ["payment_no"]],
  );
  assert.deepEqual(
    apiMock.prepareDataCompareFromTables.mock.calls.map((call) => call[0].keyColumns),
    [["user_id"], ["tenant_id", "order_id"], ["payment_no"]],
  );
});

test("gives one table its own match columns without changing the other tables", async () => {
  const session = await runSession(baseConfig({ selectedSourceTables: ["users", "orders", "payments"], keyColumnsByTable: { payments: ["tenant_id", "payment_no"] } }), [
    { sourceTable: "users", targetTable: "users" },
    { sourceTable: "orders", targetTable: "orders" },
    { sourceTable: "payments", targetTable: "payments" },
  ]);

  assert.equal(session.status, "completed");
  assert.deepEqual(
    session.batchResults.map((result) => ({ table: result.sourceTable, keys: result.keyColumns })),
    [
      { table: "users", keys: ["user_id"] },
      { table: "orders", keys: ["tenant_id", "order_id"] },
      { table: "payments", keys: ["tenant_id", "payment_no"] },
    ],
  );
  assert.deepEqual(keyColumnsOf(2), ["tenant_id", "payment_no"]);
});

test("keeps a manual match-column selection on one table even when another table is overridden too", async () => {
  const session = await runSession(baseConfig({ selectedSourceTables: ["users", "orders"], keyColumnsByTable: { users: ["email"], orders: ["amount"] } }), [
    { sourceTable: "users", targetTable: "users" },
    { sourceTable: "orders", targetTable: "orders" },
  ]);

  assert.equal(session.status, "completed");
  assert.deepEqual(keyColumnsOf(0), ["email"]);
  assert.deepEqual(keyColumnsOf(1), ["amount"]);
});

test("reports a missing key column only for the table that configures it", async () => {
  const session = await runSession(baseConfig({ selectedSourceTables: ["users", "orders"], keyColumnsByTable: { users: ["does_not_exist"] } }), [
    { sourceTable: "users", targetTable: "users" },
    { sourceTable: "orders", targetTable: "orders" },
  ]);

  assert.equal(session.status, "completed");
  assert.equal(session.batchResults[0]?.status, "error");
  assert.match(session.batchResults[0]?.error ?? "", /does_not_exist/);
  assert.equal(session.batchResults[1]?.status, "different");
});

test("never falls back to the first column when a table has no primary key", async () => {
  const session = await runSession(baseConfig({ selectedSourceTables: ["logs"], targetTable: "logs" }), [{ sourceTable: "logs", targetTable: "logs" }]);

  assert.equal(session.batchResults.length, 1);
  assert.equal(session.batchResults[0]?.status, "error");
  assert.equal(apiMock.prepareDataCompareFromTables.mock.calls.length, 0);
});

test("treats an explicitly cleared selection as missing match columns instead of restoring the primary key", async () => {
  const session = await runSession(baseConfig({ selectedSourceTables: ["users"], targetTable: "users", keyColumnsByTable: { users: [] } }), [{ sourceTable: "users", targetTable: "users" }]);

  assert.equal(session.batchResults[0]?.status, "error");
  assert.equal(apiMock.prepareDataCompareFromTables.mock.calls.length, 0);
});

test("canonicalizes a manual match column against an upper-cased target column", async () => {
  apiMock.getColumns.mockImplementation((connectionId: string, _database: string, _schema: string, table: string) => {
    if (table !== "legacy") return Promise.resolve(TABLES[table] ?? []);
    return Promise.resolve(connectionId === "source" ? [column("snid", true), column("username")] : [column("SNID", true), column("USERNAME")]);
  });

  const session = await runSession(baseConfig({ selectedSourceTables: ["legacy"], targetTable: "legacy", keyColumnsByTable: { legacy: ["snid", "Username"] } }), [{ sourceTable: "legacy", targetTable: "legacy" }]);

  assert.equal(session.batchResults[0]?.status, "different");
  assert.deepEqual(keyColumnsOf(0), ["SNID", "USERNAME"]);
  assert.deepEqual(apiMock.prepareDataCompareFromTables.mock.calls[0]?.[0].sourceColumns, ["snid", "username"]);
  assert.deepEqual(apiMock.prepareDataCompareFromTables.mock.calls[0]?.[0].columns, ["SNID", "USERNAME"]);
});

test("uses a per-table override for a source table whose target table is missing", async () => {
  apiMock.prepareDataCompareMissingTarget.mockResolvedValue(preparationFor("users"));

  const session = await runSession(baseConfig({ selectedSourceTables: ["users"], targetTable: "users", keyColumnsByTable: { users: ["email"] }, targetTables: ["orders"] }), [{ sourceTable: "users", targetTable: "users" }]);

  assert.equal(session.batchResults[0]?.status, "different");
  assert.deepEqual(session.batchResults[0]?.keyColumns, ["email"]);
  assert.deepEqual(apiMock.prepareDataCompareMissingTarget.mock.calls[0]?.[0].keyColumns, ["email"]);
});

test("keeps the configured per-table match columns after cloning the session config", async () => {
  const input = baseConfig({ selectedSourceTables: ["users"], targetTable: "users", keyColumnsByTable: { users: [" user_id ", "USER_ID", "email"] } });
  const session = await runSession(input, [{ sourceTable: "users", targetTable: "users" }]);

  assert.deepEqual(session.config.keyColumnsByTable, { users: ["user_id", "email"] });
  assert.deepEqual(keyColumnsOf(0), ["user_id", "email"]);
  // The session must not share the caller's arrays.
  input.keyColumnsByTable.users?.push("name");
  assert.deepEqual(session.config.keyColumnsByTable, { users: ["user_id", "email"] });
});

test("normalizes a per-table match-column map", () => {
  assert.deepEqual(normalizeKeyColumnOverrides({ users: [" id ", ""], orders: [], "": ["x"] }), { users: ["id"], orders: [] });
  assert.deepEqual(normalizeKeyColumnOverrides(undefined), {});
});
