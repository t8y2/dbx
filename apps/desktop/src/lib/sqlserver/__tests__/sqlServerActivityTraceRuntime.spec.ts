import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";

const mocks = vi.hoisted(() => ({
  executeQuery: vi.fn(),
  cancelQuery: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => mocks);

function result(columns: string[] = [], rows: QueryResult["rows"] = []): QueryResult {
  return { columns, rows, affected_rows: 0, execution_time_ms: 0 };
}

function capabilityResult(): QueryResult {
  return result(
    [
      "product_version",
      "engine_edition",
      "database_id",
      "can_alter_event_session",
      "can_view_server_state",
      "can_view_server_performance_state",
      "has_rpc_completed_event",
      "has_sql_batch_completed_event",
      "has_sp_statement_completed_event",
      "has_ring_buffer_target",
      "has_database_id_predicate",
      "has_like_predicate",
      "available_actions",
    ],
    [["16.0.4225.2", 3, 5, 1, 1, 1, 1, 1, 1, 1, 1, 1, "client_app_name,client_hostname,database_id,database_name,server_principal_name,session_id,sql_text"]],
  );
}

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
  return data;
}

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const inspect = () => {
      if (predicate()) resolve();
      else if (Date.now() >= deadline) reject(new Error("Timed out waiting for trace runtime state"));
      else setTimeout(inspect, 0);
    };
    inspect();
  });
}

describe("SQL Server activity trace runtime", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    const { disposeAllSqlServerActivityTraces } = await import("../sqlServerActivityTraceRuntime");
    await disposeAllSqlServerActivityTraces();
  });

  afterEach(async () => {
    const { disposeAllSqlServerActivityTraces } = await import("../sqlServerActivityTraceRuntime");
    await disposeAllSqlServerActivityTraces();
    vi.unstubAllGlobals();
  });

  it("keeps trace state in the tab runtime until the tab is explicitly disposed", async () => {
    mocks.executeQuery.mockImplementation(async (_connectionId: string, _database: string, sql: string) => {
      if (sql.includes("sys.dm_xe_objects")) return capabilityResult();
      return result(sql.includes("sys.server_event_sessions") && sql.includes("SELECT name") ? ["name"] : [], []);
    });
    mocks.cancelQuery.mockResolvedValue(true);

    const { activeSqlServerActivityTraceRuntimeCount, disposeSqlServerActivityTrace, getSqlServerActivityTraceRuntime } = await import("../sqlServerActivityTraceRuntime");
    const runtime = getSqlServerActivityTraceRuntime("tab-1", "sqlserver-1", "app");
    await runtime.start();
    runtime.state.sqlFilter = "orders";

    const recreatedComponentRuntime = getSqlServerActivityTraceRuntime("tab-1", "sqlserver-1", "app");
    expect(recreatedComponentRuntime).toBe(runtime);
    expect(recreatedComponentRuntime.state.status).toBe("running");
    expect(recreatedComponentRuntime.state.sqlFilter).toBe("orders");
    expect(activeSqlServerActivityTraceRuntimeCount()).toBe(1);

    await disposeSqlServerActivityTrace("tab-1");
    expect(activeSqlServerActivityTraceRuntimeCount()).toBe(0);
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).includes("STATE = STOP"))).toBe(true);
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).includes("DROP EVENT SESSION"))).toBe(true);
  });

  it("cancels an in-flight incremental read before dropping the session", async () => {
    let settleRead: ((value: QueryResult) => void) | undefined;
    mocks.executeQuery.mockImplementation(async (_connectionId: string, _database: string, sql: string) => {
      if (sql.includes("sys.dm_xe_objects")) return capabilityResult();
      if (sql.includes("CROSS APPLY target_data.nodes")) {
        return new Promise<QueryResult>((resolve) => {
          settleRead = resolve;
        });
      }
      return result(sql.includes("sys.server_event_sessions") && sql.includes("SELECT name") ? ["name"] : [], []);
    });
    mocks.cancelQuery.mockImplementation(async () => {
      settleRead?.(result());
      return true;
    });

    const { disposeSqlServerActivityTrace, getSqlServerActivityTraceRuntime } = await import("../sqlServerActivityTraceRuntime");
    const runtime = getSqlServerActivityTraceRuntime("tab-2", "sqlserver-1", "app");
    const starting = runtime.start();
    await waitFor(() => runtime.state.polling);
    const readCall = mocks.executeQuery.mock.calls.find((call) => String(call[2]).includes("CROSS APPLY target_data.nodes"));
    const executionId = readCall?.[4];

    await disposeSqlServerActivityTrace("tab-2");
    await starting;

    expect(typeof executionId).toBe("string");
    expect(mocks.cancelQuery).toHaveBeenCalledWith(executionId);
    const cancelOrder = mocks.cancelQuery.mock.invocationCallOrder[0];
    const finalDropOrder = mocks.executeQuery.mock.calls.map((call, index) => (String(call[2]).includes("DROP EVENT SESSION") ? mocks.executeQuery.mock.invocationCallOrder[index] : 0)).find((order) => order > cancelOrder);
    expect(finalDropOrder).toBeDefined();
  });

  it("waits for an in-flight session creation before disposing the tab", async () => {
    let finishCreate: (() => void) | undefined;
    mocks.executeQuery.mockImplementation(async (_connectionId: string, _database: string, sql: string) => {
      if (sql.includes("sys.dm_xe_objects")) return capabilityResult();
      if (sql.includes("CREATE EVENT SESSION")) {
        await new Promise<void>((resolve) => {
          finishCreate = resolve;
        });
      }
      return result(sql.includes("sys.server_event_sessions") && sql.includes("SELECT name") ? ["name"] : [], []);
    });
    mocks.cancelQuery.mockResolvedValue(true);

    const { disposeSqlServerActivityTrace, getSqlServerActivityTraceRuntime } = await import("../sqlServerActivityTraceRuntime");
    const runtime = getSqlServerActivityTraceRuntime("tab-starting", "sqlserver-1", "app");
    const starting = runtime.start();
    await waitFor(() => mocks.executeQuery.mock.calls.some((call) => String(call[2]).includes("CREATE EVENT SESSION")));

    const disposing = disposeSqlServerActivityTrace("tab-starting");
    await Promise.resolve();
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).includes("DROP EVENT SESSION") && !String(call[2]).includes("CREATE EVENT SESSION"))).toBe(false);

    finishCreate?.();
    await Promise.all([starting, disposing]);

    const createOrder = mocks.executeQuery.mock.calls.map((call, index) => (String(call[2]).includes("CREATE EVENT SESSION") ? mocks.executeQuery.mock.invocationCallOrder[index] : 0)).find(Boolean);
    const dropOrder = mocks.executeQuery.mock.calls.map((call, index) => (String(call[2]).includes("DROP EVENT SESSION") && !String(call[2]).includes("CREATE EVENT SESSION") ? mocks.executeQuery.mock.invocationCallOrder[index] : 0)).find((order) => order > (createOrder ?? 0));
    expect(dropOrder).toBeDefined();
    expect(runtime.state.sessionName).toBe("");
  });

  it("cleans persisted crash leftovers independently on the next connection", async () => {
    const data = installLocalStorage();
    const expiresAt = Date.now() - 1;
    const { buildSqlServerTraceSessionName } = await import("../sqlServerActivityTrace");
    const sessionName = buildSqlServerTraceSessionName(expiresAt, 0.25);
    const activeExpiresAt = Date.now() + 60_000;
    const activeSessionName = buildSqlServerTraceSessionName(activeExpiresAt, 0.5);
    data.set(
      "dbx:sqlserver-trace:pending-sessions:v1",
      JSON.stringify([
        { connectionId: "sqlserver-1", database: "app", sessionName, expiresAt },
        { connectionId: "sqlserver-1", database: "app", sessionName: activeSessionName, expiresAt: activeExpiresAt },
      ]),
    );
    mocks.executeQuery.mockImplementation(async (_connectionId: string, _database: string, sql: string) => {
      if (sql.includes("SELECT name") && sql.includes("sys.server_event_sessions")) return result(["name"], [[sessionName], [activeSessionName]]);
      return result();
    });

    const { cleanupStaleSqlServerTraceSessions } = await import("../sqlServerActivityTraceRuntime");
    expect(await cleanupStaleSqlServerTraceSessions("sqlserver-1", "app")).toBe(1);
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).includes(`DROP EVENT SESSION [${sessionName}]`))).toBe(true);
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).includes(`DROP EVENT SESSION [${activeSessionName}]`))).toBe(false);
    expect(JSON.parse(data.get("dbx:sqlserver-trace:pending-sessions:v1") || "[]")).toEqual([{ connectionId: "sqlserver-1", database: "app", sessionName: activeSessionName, expiresAt: activeExpiresAt }]);
  });
});
