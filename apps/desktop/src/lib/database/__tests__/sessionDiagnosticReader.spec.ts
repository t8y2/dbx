import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";
import { createSessionDiagnosticReader } from "../sessionDiagnosticReader";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const result = (rows: QueryResult["rows"] = [["value"]]): QueryResult => ({ columns: ["VALUE"], rows, affected_rows: 0, execution_time_ms: 1 });
function backend() {
  return {
    executeQuery: vi.fn().mockResolvedValue(result()),
    cancelQuery: vi.fn().mockResolvedValue(true),
    closeClientConnectionSession: vi.fn().mockResolvedValue(true),
    readLargeValueChunk: vi.fn(),
  };
}
afterEach(() => vi.useRealTimers());

describe("isolated session diagnostic reads", () => {
  it("uses a dedicated session and a unique execution id for every dictionary read", async () => {
    const api = backend();
    const reader = createSessionDiagnosticReader({ connectionId: "ob", database: "APP" }, api);
    await reader.query("SELECT 1 FROM DUAL", 2);
    await reader.query("SELECT 2 FROM DUAL", 4);
    const [first, second] = api.executeQuery.mock.calls;
    expect(first?.slice(0, 4)).toEqual(["ob", "APP", "SELECT 1 FROM DUAL", undefined]);
    expect(first?.[4]).not.toBe(second?.[4]);
    expect(first?.[5]).toMatchObject({ clientSessionId: expect.stringMatching(/^session-diagnostics:/), maxRows: 2, timeoutSecs: 10 });
    expect(second?.[5].clientSessionId).toBe(first?.[5].clientSessionId);
    reader.close();
    await vi.waitFor(() => expect(api.closeClientConnectionSession).toHaveBeenCalledOnce());
  });

  it("stops local waiting even if query and cancellation never return, then cleans up only after transport ends", async () => {
    const api = backend();
    const pending = deferred<QueryResult>();
    api.executeQuery.mockReturnValue(pending.promise);
    api.cancelQuery.mockReturnValue(new Promise(() => {}));
    const reader = createSessionDiagnosticReader({ connectionId: "ob", database: "APP" }, api);
    const reading = reader.query("SELECT 1 FROM DUAL");
    const stopped = expect(reading).rejects.toMatchObject({ reason: "cancelled" });
    reader.stop();
    await stopped;
    expect(api.cancelQuery).toHaveBeenCalledWith(api.executeQuery.mock.calls[0]?.[4]);
    expect(api.closeClientConnectionSession).not.toHaveBeenCalled();
    await expect(reader.query("SELECT 2 FROM DUAL")).rejects.toMatchObject({ reason: "cancelled" });
    expect(api.executeQuery).toHaveBeenCalledOnce();
    pending.resolve(result());
    await vi.waitFor(() => expect(api.closeClientConnectionSession).toHaveBeenCalledOnce());
  });

  it("ends a stalled read on its bounded timeout without waiting for server cancellation", async () => {
    vi.useFakeTimers();
    const api = backend();
    api.executeQuery.mockReturnValue(new Promise(() => {}));
    const reader = createSessionDiagnosticReader({ connectionId: "ob", database: "APP" }, api);
    const reading = expect(reader.query("SELECT 1 FROM DUAL")).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(10_000);
    await reading;
    expect(api.cancelQuery).toHaveBeenCalledOnce();
    expect(api.closeClientConnectionSession).not.toHaveBeenCalled();
  });

  it("rejects backend execution errors and preserves collection completeness flags", async () => {
    const api = backend();
    api.executeQuery.mockResolvedValueOnce({ ...result(), execution_error: true, error: { message: "ORA-01031: insufficient privileges" } });
    const reader = createSessionDiagnosticReader({ connectionId: "ob", database: "APP" }, api);
    await expect(reader.query("SELECT 1 FROM DUAL")).rejects.toThrow("ORA-01031");
    api.executeQuery.mockResolvedValueOnce({ ...result(), truncated: true, has_more: true });
    expect(await reader.query("SELECT 2 FROM DUAL")).toMatchObject({ truncated: true, has_more: true });
    reader.close();
  });

  it("passes the chunk cancellation id and retains the dedicated session until the actual chunk transport finishes", async () => {
    const api = backend();
    const chunk = deferred<any>();
    api.readLargeValueChunk.mockReturnValue(chunk.promise);
    api.executeQuery.mockResolvedValueOnce({ ...result([["preview"]]), large_value_cells: [{ row_index: 0, column_index: 0, original_bytes: 100, value_ref: "sql-ref" }] });
    const reader = createSessionDiagnosticReader({ connectionId: "ob", database: "APP" }, api);
    const value = await reader.query("SELECT SQL_FULLTEXT FROM GV$SQL");
    const clientSessionId = api.executeQuery.mock.calls[0]?.[5].clientSessionId;
    const reading = reader.readCell(value, 0, 0);
    const stopped = expect(reading).rejects.toMatchObject({ reason: "cancelled" });
    reader.stop();
    await stopped;
    const request = api.readLargeValueChunk.mock.calls[0]?.[0];
    expect(request).toMatchObject({ clientSessionId, valueRef: "sql-ref", offset: 0, executionId: expect.any(String) });
    expect(api.cancelQuery).toHaveBeenCalledWith(request.executionId);
    expect(api.closeClientConnectionSession).not.toHaveBeenCalled();
    chunk.resolve({ status: "ok", data: "完整😀", next_offset: 3, eof: true, value_kind: "text" });
    await vi.waitFor(() => expect(api.closeClientConnectionSession).toHaveBeenCalledOnce());
    expect(value.rows).toEqual([["preview"]]);
  });

  it("materializes the original text and refuses missing or foreign snapshot references", async () => {
    const api = backend();
    api.readLargeValueChunk.mockResolvedValue({ status: "ok", data: "完整😀", next_offset: 3, eof: true, value_kind: "text" });
    api.executeQuery.mockResolvedValueOnce({ ...result([["preview"]]), large_value_cells: [{ row_index: 0, column_index: 0, original_bytes: 100, value_ref: "sql-ref" }] });
    const reader = createSessionDiagnosticReader({ connectionId: "ob", database: "APP" }, api);
    const value = await reader.query("SELECT SQL_FULLTEXT FROM GV$SQL");
    const clientSessionId = api.executeQuery.mock.calls[0]?.[5].clientSessionId;
    expect(value.large_value_context).toEqual({ connectionId: "ob", database: "APP", clientSessionId });
    expect(await reader.readCell(value, 0, 0)).toBe("完整😀");
    api.readLargeValueChunk.mockResolvedValueOnce({ status: "expired" });
    await expect(reader.readCell(value, 0, 0)).rejects.toThrow("refresh diagnostics");
    expect(api.executeQuery).toHaveBeenCalledOnce();
    await expect(reader.readCell({ ...value, large_value_context: { connectionId: "ob", database: "APP", clientSessionId: "editor" } }, 0, 0)).rejects.toThrow("context");
    await expect(reader.readCell({ ...value, large_value_cells: [{ row_index: 0, column_index: 0, original_bytes: 100 }] }, 0, 0)).rejects.toThrow("reference");
    reader.close();
  });
});
