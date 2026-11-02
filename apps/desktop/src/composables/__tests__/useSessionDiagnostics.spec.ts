import { effectScope, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";
import { useSessionDiagnostics, type SessionDiagnosticsContext } from "../useSessionDiagnostics";

const api = vi.hoisted(() => ({ executeQuery: vi.fn(), cancelQuery: vi.fn(), closeClientConnectionSession: vi.fn(), readLargeValueChunk: vi.fn() }));
vi.mock("@/lib/backend/api", () => api);

const scopes: ReturnType<typeof effectScope>[] = [];
const sqlId = "0123456789abc";
function result(row: Record<string, unknown>): QueryResult {
  return { columns: Object.keys(row), rows: [Object.values(row) as string[]], affected_rows: 0, execution_time_ms: 1 };
}
function context(connectionId = "oracle"): SessionDiagnosticsContext {
  return {
    connection: { id: connectionId, name: connectionId, db_type: "oracle", host: "localhost", port: 1521, username: "APP" },
    database: "",
    engine: "oracle",
    versionMajor: 19,
    row: { id: "17", serial: "8", instance: "1", container: "3", user: "APP", auditSession: "99", logonTime: "2026-10-21 10:00:00" },
  };
}
function start(value = context()) {
  const current = ref(value),
    scope = effectScope();
  scopes.push(scope);
  const diagnostics = scope.run(() => useSessionDiagnostics(current))!;
  return { current, diagnostics, scope };
}
beforeEach(() => {
  vi.useRealTimers();
  api.cancelQuery.mockReset().mockResolvedValue(true);
  api.closeClientConnectionSession.mockReset().mockResolvedValue(true);
  api.readLargeValueChunk.mockReset();
  api.executeQuery.mockReset().mockImplementation(async (connectionId: string, _db: string, sql: string) => {
    if (sql.includes("FROM GV$SESSION_LONGOPS")) return { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 };
    if (sql.includes("FROM GV$SQL_PLAN_STATISTICS_ALL")) return result({ STARTS: "1", OUTPUT_ROWS: "1" });
    if (sql.includes("FROM GV$SQL_PLAN p")) return result({ ID: "0", PARENT_ID: null, OPERATION: "SELECT STATEMENT", COST: "0", ESTIMATED_ROWS: "1" });
    if (sql.includes("FROM GV$SESSION s")) return result({ SQL_ID: sqlId, CHILD_NUMBER: "1", SQL_EXEC_ID: "2", SQL_EXEC_START: "2026-10-21T20:00:00", STATE: "WAITING", EVENT: "fixture", WAIT_CLASS: "Other", SECONDS_IN_WAIT: "0" });
    if (sql.includes("FROM GV$SQL s")) return result({ SQL_ID: sqlId, CHILD_NUMBER: "1", CHILD_ADDRESS: "000000001234ABCD", FIRST_LOAD_TIME: "2026-10-21/19:00:00", PLAN_HASH: "9", SQL_TEXT: connectionId, SOURCE_LENGTH: String(connectionId.length), EXECUTIONS: "2" });
    throw new Error("Unexpected query");
  });
});
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
  vi.useRealTimers();
});

describe("session diagnostic sampling lifecycle", () => {
  it("samples the full workflow and closes its own session, keeping engine and captured identity", async () => {
    const { diagnostics } = start();
    await vi.waitFor(() => expect(diagnostics.busy.value).toBe(false));
    expect(diagnostics.snapshot.value.sql.data?.text).toBe("oracle");
    expect(diagnostics.snapshot.value.plan.data?.binding).toBe("cursor");
    expect(diagnostics.snapshot.value.metrics.data?.some((value) => value.scope === "cursor_cumulative")).toBe(true);
    expect(diagnostics.snapshot.value.longOperations.state).toBe("empty");
    expect(diagnostics.snapshot.value.startedAt).toBeTruthy();
    expect(diagnostics.snapshot.value.finishedAt).toBeTruthy();
    await vi.waitFor(() => expect(api.closeClientConnectionSession).toHaveBeenCalledOnce());
  });

  it("stops busy locally and ignores a capture result that arrives after a connection switch", async () => {
    let finish!: (value: QueryResult) => void;
    api.executeQuery.mockImplementationOnce(
      () =>
        new Promise<QueryResult>((resolve) => {
          finish = resolve;
        }),
    );
    api.cancelQuery.mockReturnValue(new Promise(() => {}));
    const { current, diagnostics } = start(context("first"));
    expect(diagnostics.busy.value).toBe(true);
    current.value = context("second");
    expect(diagnostics.busy.value).toBe(false);
    expect(diagnostics.snapshot.value.sql.data).toBeUndefined();
    expect(api.executeQuery.mock.calls.some(([id]) => id === "second")).toBe(false);
    await diagnostics.refresh();
    await vi.waitFor(() => expect(diagnostics.snapshot.value.sql.data?.text).toBe("second"));
    finish(result({ SQL_ID: "fedcba9876543", CHILD_NUMBER: "9" }));
    await Promise.resolve();
    expect(diagnostics.snapshot.value.sql.data?.text).toBe("second");
    expect(api.executeQuery.mock.calls.filter(([id]) => id === "first")).toHaveLength(1);
    expect(api.cancelQuery).toHaveBeenCalledWith(api.executeQuery.mock.calls[0]?.[4]);
  });

  it("preserves verified data with its original data timestamp when a refresh loses permission", async () => {
    const { diagnostics } = start();
    await vi.waitFor(() => expect(diagnostics.busy.value).toBe(false));
    const original = diagnostics.snapshot.value.sql.dataSampledAt;
    const originalQuery = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args) => {
      if (String(args[2]).includes("FROM GV$SQL s")) throw new Error("ORA-01031: insufficient privileges");
      return originalQuery(...args);
    });
    await diagnostics.refresh();
    expect(diagnostics.snapshot.value.sql).toMatchObject({ state: "unavailable", reason: "permission_denied", dataSampledAt: original, data: { text: "oracle" } });
    expect(diagnostics.snapshot.value.waits.state).toBe("ready");
  });

  it("stops reading without discarding already verified sections", async () => {
    const { diagnostics } = start();
    await vi.waitFor(() => expect(diagnostics.busy.value).toBe(false));
    const originalQuery = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation((...args) => (String(args[2]).includes("FROM GV$SQL_PLAN p") ? new Promise(() => {}) : originalQuery(...args)));
    void diagnostics.refresh();
    await vi.waitFor(() => expect(diagnostics.snapshot.value.sql.state).toBe("ready"));
    diagnostics.stop();
    expect(diagnostics.busy.value).toBe(false);
    expect(diagnostics.snapshot.value.sql.data?.text).toBe("oracle");
    expect(diagnostics.snapshot.value.plan.state).toBe("cancelled");
    expect(diagnostics.snapshot.value.interrupted).toBe("cancelled");
    expect(diagnostics.snapshot.value.plan.data?.binding).toBe("cursor");
  });

  it("reports an asynchronous session-cleanup failure without replacing collected evidence", async () => {
    api.closeClientConnectionSession.mockRejectedValue(new Error("fixture cleanup failure"));
    const { diagnostics } = start();
    await vi.waitFor(() => expect(diagnostics.cleanupFailed.value).toBe(true));
    expect(diagnostics.snapshot.value.sql.data?.text).toBe("oracle");
  });

  it("invalidates an in-flight sample when disposed and sends no later queries", async () => {
    api.executeQuery.mockReturnValue(new Promise(() => {}));
    const { diagnostics, scope } = start();
    scope.stop();
    expect(diagnostics.busy.value).toBe(false);
    await Promise.resolve();
    expect(api.executeQuery).toHaveBeenCalledOnce();
    expect(api.cancelQuery).toHaveBeenCalledOnce();
  });
});
