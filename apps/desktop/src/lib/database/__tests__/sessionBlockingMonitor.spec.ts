import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";
import { blockingPaths, createSessionBlockingMonitor, monitorError, type MonitorContext } from "../sessionBlockingMonitor";
vi.mock("@/lib/backend/api", () => ({}));
const oracle: MonitorContext = { connectionId: "dedicated", database: "PDB", engine: "oracle" };
const ob: MonitorContext = { ...oracle, engine: "oceanbase-oracle" };
const signal = () => new AbortController().signal;
function result(rows: Record<string, unknown>[]): QueryResult {
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { columns, rows: rows.map((row) => columns.map((column) => row[column])), affected_rows: 0, execution_time_ms: 0 } as QueryResult;
}
const session = (instance: string, sid: string, serial: string, holder?: [string, string, string]) => ({
  INSTANCE_ID: instance,
  SID: sid,
  SERIAL_ID: serial,
  STATUS: "ACTIVE",
  STATE: "WAITING",
  EVENT: "enq: TX - row lock contention",
  SQL_ID: "0123456789abc",
  BLOCKING_STATUS: holder ? "VALID" : "NO HOLDER",
  HOLDER_INSTANCE: holder?.[0] ?? null,
  HOLDER_SID: holder?.[1] ?? null,
  HOLDER_SERIAL: holder?.[2] ?? null,
});
const obSession = (tenant: string, sid: string, tx: string, node = "10.0.0.1") => ({ TENANT: tenant, SVR_IP: node, SVR_PORT: "2882", SID: sid, TRANS_ID: tx, STATE: "ACTIVE", SQL_ID: "abc" });
function obBackend(before: Record<string, unknown>[], locks: Record<string, unknown>[], after = before, legacy = false) {
  const executeQuery = vi
    .fn()
    .mockResolvedValueOnce(result(before))
    .mockResolvedValueOnce(
      result([
        { TENANT_NAME: "one", TENANT_ID: "1001" },
        { TENANT_NAME: "two", TENANT_ID: "1002" },
      ]),
    );
  if (legacy) executeQuery.mockRejectedValueOnce(new Error("ORA-00904: ID3"));
  else executeQuery.mockResolvedValueOnce(result([]));
  executeQuery.mockResolvedValueOnce(result(locks)).mockResolvedValueOnce(result(after));
  return { executeQuery, cancelQuery: vi.fn().mockResolvedValue(undefined) };
}
afterEach(() => vi.useRealTimers());
describe("read-only session blocking snapshots", () => {
  it("follows a multi-instance chain without merging equal SIDs and detects cycles", async () => {
    const backend = { executeQuery: vi.fn().mockResolvedValue(result([session("1", "7", "10", ["2", "7", "11"]), session("2", "7", "11", ["3", "8", "12"]), session("3", "8", "12", ["1", "7", "10"])])), cancelQuery: vi.fn() };
    const snapshot = await createSessionBlockingMonitor(backend).collect(oracle, signal());
    expect(snapshot.sessions).toHaveLength(3);
    expect(blockingPaths(snapshot, snapshot.sessions[0].key)).toEqual([{ keys: [snapshot.sessions[0].key, snapshot.sessions[1].key, snapshot.sessions[2].key, snapshot.sessions[0].key], end: "cycle" }]);
    expect(backend.executeQuery.mock.calls[0].slice(3, 6)).toEqual([undefined, expect.any(String), { maxRows: 1001, timeoutSecs: 10 }]);
    expect(JSON.stringify(snapshot)).not.toContain("password");
  });
  it("does not attach an invisible blocker to a reused session ID", async () => {
    const backend = { executeQuery: vi.fn().mockResolvedValue(result([session("1", "1", "9", ["2", "7", "10"]), session("2", "7", "11")])), cancelQuery: vi.fn() };
    const snapshot = await createSessionBlockingMonitor(backend).collect(oracle, signal());
    expect(snapshot.sessions).toHaveLength(3);
    expect(snapshot.sessions[2].visible).toBe(false);
    expect(blockingPaths(snapshot, snapshot.sessions[0].key)[0].end).toBe("unknown");
    expect(snapshot.limitations).toContain("invisible_holder");
  });
  it.each([true, false])("links OB transaction IDs with tenant and stable server identities (legacy=%s)", async (legacy) => {
    const rows = [obSession("one", "5", "9007199254740993"), obSession("one", "5", "200", "10.0.0.2"), obSession("two", "5", "200", "10.0.0.2")];
    const backend = obBackend(rows, [{ TENANT_ID: "1001", TRANS_ID: "9007199254740993", HOLDER_TRANS_ID: "200", TYPE: legacy ? "TX" : "TR" }], rows, legacy);
    const snapshot = await createSessionBlockingMonitor(backend).collect(ob, signal());
    expect(snapshot.edges).toHaveLength(1);
    expect(snapshot.edges[0]).toMatchObject({ waiter: snapshot.sessions[0].key, holder: snapshot.sessions[1].key });
    expect(snapshot.sessions[2].blocking).toBe("unknown");
    expect(snapshot.limitations.includes("legacy_locks")).toBe(legacy);
    const sql = backend.executeQuery.mock.calls.map((call) => call[2]).join("\n");
    expect(sql).not.toMatch(/SQL_AUDIT|\bINFO\b|ROWKEY|ALTER|KILL|ROLLBACK|UPDATE|DELETE/);
    expect(backend.executeQuery.mock.calls.every((call) => /^SELECT /.test(call[2]))).toBe(true);
  });
  it("keeps missing or changed OB transactions unresolved instead of guessing from SID", async () => {
    const before = [obSession("one", "5", "100"), obSession("one", "6", "200")];
    const after = [before[0], obSession("one", "6", "201")];
    const snapshot = await createSessionBlockingMonitor(obBackend(before, [{ TENANT_ID: "1001", TRANS_ID: "100", HOLDER_TRANS_ID: "200", TYPE: "TX" }], after)).collect(ob, signal());
    expect(snapshot.limitations).toContain("identity_changed");
    expect(snapshot.edges[0].holder).not.toBe(snapshot.sessions[1].key);
    expect(blockingPaths(snapshot, snapshot.sessions[0].key)[0].end).toBe("unknown");
  });
  it("keeps visible sessions when lock permissions are missing without claiming no blocking", async () => {
    const rows = [obSession("one", "5", "100")];
    const backend = { executeQuery: vi.fn().mockResolvedValueOnce(result(rows)).mockResolvedValueOnce(result([])).mockRejectedValueOnce(new Error("ORA-01031 secret")).mockResolvedValueOnce(result(rows)), cancelQuery: vi.fn() };
    const snapshot = await createSessionBlockingMonitor(backend).collect(ob, signal());
    expect(snapshot.limitations).toContain("permission_denied");
    expect(snapshot.sessions[0].blocking).toBe("unknown");
    expect(snapshot.edges).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain("secret");
  });
  it("distinguishes empty visibility from truncation", async () => {
    const backend = {
      executeQuery: vi
        .fn()
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result(Array.from({ length: 1001 }, (_, i) => session("1", String(i), "1")))),
      cancelQuery: vi.fn(),
    };
    const monitor = createSessionBlockingMonitor(backend);
    expect((await monitor.collect(oracle, signal())).sessions).toEqual([]);
    const truncated = await monitor.collect(oracle, signal());
    expect(truncated.sessions).toHaveLength(1000);
    expect(truncated.limitations).toContain("truncated");
  });
  it("marks a backend-truncated snapshot incomplete below the local row limit", async () => {
    const backend = { executeQuery: vi.fn().mockResolvedValue({ ...result([session("1", "7", "10")]), truncated: true }), cancelQuery: vi.fn() };
    const snapshot = await createSessionBlockingMonitor(backend).collect(oracle, signal());
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.limitations).toContain("truncated");
  });
  it("marks a snapshot with more backend rows incomplete below the local row limit", async () => {
    const backend = { executeQuery: vi.fn().mockResolvedValue({ ...result([session("1", "7", "10")]), has_more: true }), cancelQuery: vi.fn() };
    const snapshot = await createSessionBlockingMonitor(backend).collect(oracle, signal());
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.limitations).toContain("truncated");
  });
  it.each([{}, { truncated: false }, { has_more: false }, { truncated: false, has_more: false }])("keeps a complete snapshot unmarked for backend flags %j", async (flags) => {
    const backend = { executeQuery: vi.fn().mockResolvedValue({ ...result([session("1", "7", "10")]), ...flags }), cancelQuery: vi.fn() };
    const snapshot = await createSessionBlockingMonitor(backend).collect(oracle, signal());
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.limitations).not.toContain("truncated");
  });
  it.each([
    ["ORA-01031", "permission_denied"],
    ["ORA-00904", "unsupported"],
    ["socket closed", "connection_changed"],
    ["timed out", "timeout"],
    ["arbitrary failure", "failed"],
  ])("classifies %s", (message, status) => expect(monitorError(new Error(message))).toBe(status));
  it("cancels only its own query and rejects an eventual stale result", async () => {
    let finish!: (value: QueryResult) => void;
    const backend = {
      executeQuery: vi.fn().mockImplementation(
        () =>
          new Promise<QueryResult>((resolve) => {
            finish = resolve;
          }),
      ),
      cancelQuery: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new AbortController();
    const pending = createSessionBlockingMonitor(backend).collect(oracle, controller.signal);
    const assertion = expect(pending).rejects.toThrow("cancelled");
    controller.abort();
    expect(backend.cancelQuery).toHaveBeenCalledWith(backend.executeQuery.mock.calls[0][4]);
    await assertion;
    finish(result([]));
  });
  it.each(["pending", "rejected", "throws"])("enforces the deadline even if execution never returns and cancellation %s", async (cancellation) => {
    vi.useFakeTimers();
    const backend = {
      executeQuery: vi.fn().mockImplementation(() => new Promise<QueryResult>(() => {})),
      cancelQuery: vi.fn().mockImplementation(() => {
        if (cancellation === "throws") throw new Error("transport failure");
        if (cancellation === "rejected") return Promise.reject(new Error("transport failure"));
        return new Promise<void>(() => {});
      }),
    };
    const pending = createSessionBlockingMonitor(backend).collect(oracle, signal());
    const assertion = expect(pending).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(backend.cancelQuery).toHaveBeenCalledTimes(1);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
