import { describe, expect, it, vi } from "vitest";
import { compileOracleObject, inspectOracleObject, listOracleInvalidObjects, oracleCompileSql, oracleObjectKey, readOracleObjectSourceLines, type OracleInvalidObject } from "@/lib/database/oracleInvalidObjects";
import type { DatabaseType, QueryResult } from "@/types/database";

const target: OracleInvalidObject = { schema: 'Owner."A', name: "程序.T", object_type: "TYPE_BODY", status: "INVALID", object_id: "1234567890123456789", last_ddl_time: "2026-10-09 10:00:00" };
const result = (columns: string[], rows: QueryResult["rows"], overrides: Partial<QueryResult> = {}): QueryResult => ({ columns, rows, affected_rows: 0, execution_time_ms: 0, ...overrides });
const object = (overrides: Partial<OracleInvalidObject> = {}) => {
  const value = { ...target, ...overrides };
  return result(["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "STATUS", "OBJECT_ID", "LAST_DDL_TIME"], [[value.schema, value.name, value.object_type.replaceAll("_", " "), value.status, value.object_id, value.last_ddl_time]]);
};
const noErrors = () => result(["SEQUENCE", "LINE", "POSITION", "TEXT", "ATTRIBUTE", "MESSAGE_NUMBER"], []);

describe("Oracle invalid objects", () => {
  it.each([
    ["oracle", "PROCEDURE", 'ALTER PROCEDURE "Owner.""A"."程序.T" COMPILE'],
    ["oracle", "PACKAGE", 'ALTER PACKAGE "Owner.""A"."程序.T" COMPILE SPECIFICATION'],
    ["oracle", "PACKAGE_BODY", 'ALTER PACKAGE "Owner.""A"."程序.T" COMPILE BODY'],
    ["oracle", "TYPE", 'ALTER TYPE "Owner.""A"."程序.T" COMPILE SPECIFICATION'],
    ["oracle", "TYPE_BODY", 'ALTER TYPE "Owner.""A"."程序.T" COMPILE BODY'],
    ["oceanbase-oracle", "FUNCTION", 'ALTER FUNCTION "Owner.""A"."程序.T" COMPILE'],
    ["oceanbase-oracle", "TYPE", null],
    ["oceanbase-oracle", "TYPE_BODY", null],
    ["mysql", "PROCEDURE", null],
  ])("builds an exact single-object compile for %s / %s", (engine, kind, expected) => {
    expect(oracleCompileSql(engine as DatabaseType, { ...target, object_type: kind as string })).toBe(expected);
  });

  it("keeps owner/name/type identities distinct without splitting dots", () => {
    expect(oracleObjectKey(target)).not.toBe(oracleObjectKey({ ...target, schema: "Owner", name: '."A.程序.T' }));
    expect(oracleObjectKey(target)).not.toBe(oracleObjectKey({ ...target, object_type: "TYPE" }));
  });

  it("lists only actual INVALID rows with a read-only escaped owner filter", async () => {
    const response = object();
    response.rows.push([...response.rows[0].slice(0, 3), null, "2", "2026-10-09 10:00:00"]);
    const query = vi.fn().mockResolvedValue(response);
    expect((await listOracleInvalidObjects(query, "O'wner", "TYPE_BODY")).objects).toEqual([target]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/^SELECT /);
    expect(query.mock.calls[0][0]).toContain("OWNER = 'O''wner'");
    expect(query.mock.calls[0][0]).toContain("OBJECT_TYPE = 'TYPE BODY'");
  });

  it("reports another page without dropping the 101st row into the current page", async () => {
    const response = object();
    response.rows = Array.from({ length: 101 }, (_, index) => [...response.rows[0].slice(0, 1), `T${index}`, ...response.rows[0].slice(2)]);
    const page = await listOracleInvalidObjects(vi.fn().mockResolvedValue(response));
    expect(page.objects).toHaveLength(100);
    expect(page.has_more).toBe(true);
  });

  it("does not convert a dictionary denial into an empty invalid-object list", async () => {
    await expect(listOracleInvalidObjects(vi.fn().mockRejectedValue(new Error("ORA-01031")))).rejects.toThrow("ORA-01031");
  });

  it("keeps actual line numbers when OB returns multiline Chinese source in one cell", async () => {
    const query = vi.fn().mockResolvedValue(result(["LINE", "TEXT"], [[1, "TYPE BODY T AS\r\n-- 中文\r\nEND;\r\n"]]));
    expect(await readOracleObjectSourceLines(query, target)).toEqual({ state: "available", rows: [{ line: 1, text: "TYPE BODY T AS" }, { line: 2, text: "-- 中文" }, { line: 3, text: "END;" }] });
  });

  it("preserves source unavailability and error positions independently", async () => {
    const query = vi.fn().mockResolvedValueOnce(object()).mockResolvedValueOnce(result(["SEQUENCE", "LINE", "POSITION", "TEXT", "ATTRIBUTE", "MESSAGE_NUMBER"], [[2, 3, 5, "第一行错误\n第二行说明", "ERROR", 6550]])).mockResolvedValueOnce(result(["LINE", "TEXT"], []));
    const inspection = await inspectOracleObject(query, target);
    expect(inspection.errors.rows[0]).toMatchObject({ sequence: 2, line: 3, position: 5, text: "第一行错误\n第二行说明" });
    expect(inspection.source.state).toBe("unavailable");
  });

  it("never labels truncated source as complete", async () => {
    const value = await readOracleObjectSourceLines(vi.fn().mockResolvedValue(result(["LINE", "TEXT"], [[1, "TYPE T"]], { truncated: true })), target);
    expect(value.state).toBe("error");
    expect(value.rows).toEqual([]);
  });

  it.each(["object_id", "last_ddl_time", "status"] as const)("refuses a stale preview when %s changes", async (field) => {
    const execute = vi.fn();
    const value = await compileOracleObject({ databaseType: "oracle", target, query: vi.fn().mockResolvedValue(object({ [field]: "changed" })), execute });
    expect(value.outcome).toBe("changed");
    expect(value.statement_sent).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not send DDL after cancellation before execution", async () => {
    const query = vi.fn(); const execute = vi.fn();
    const value = await compileOracleObject({ databaseType: "oracle", target, query, execute, cancelled: () => true });
    expect(value.outcome).toBe("cancelled");
    expect(query).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });

  it("does not present the preview status as a fresh read when the precheck fails", async () => {
    const execute = vi.fn();
    const value = await compileOracleObject({ databaseType: "oracle", target, query: vi.fn().mockRejectedValue(new Error("Disconnected")), execute });
    expect(value).toMatchObject({ outcome: "failed", object: null, statement_sent: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["VALID", "INVALID", "UNKNOWN"])("reports the post-compile dictionary state %s", async (status) => {
    const query = vi.fn().mockResolvedValueOnce(object()).mockResolvedValueOnce(object({ status })).mockResolvedValueOnce(noErrors());
    const execute = vi.fn().mockResolvedValue(true);
    const value = await compileOracleObject({ databaseType: "oracle", target, query, execute });
    expect(value.outcome).toBe(status.toLowerCase());
    expect(value.statement_sent).toBe(true);
    expect(execute).toHaveBeenCalledExactlyOnceWith('ALTER TYPE "Owner.""A"."程序.T" COMPILE BODY');
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("reads the final state after a sent DDL fails and keeps its error", async () => {
    const query = vi.fn().mockResolvedValueOnce(object()).mockResolvedValueOnce(object()).mockResolvedValueOnce(noErrors());
    const value = await compileOracleObject({ databaseType: "oracle", target, query, execute: vi.fn().mockRejectedValue(new Error("ORA-01031")) });
    expect(value).toMatchObject({ outcome: "failed", statement_sent: true, execution_error: "ORA-01031", object: target });
  });

  it("does not claim success when compile-error visibility is denied", async () => {
    const query = vi.fn().mockResolvedValueOnce(object()).mockResolvedValueOnce(object({ status: "VALID" })).mockRejectedValueOnce(new Error("ORA-01031"));
    const value = await compileOracleObject({ databaseType: "oracle", target, query, execute: vi.fn().mockResolvedValue(true) });
    expect(value.outcome).toBe("unknown"); expect(value.errors.state).toBe("denied");
  });

  it("records cancellation after dispatch without pretending that DDL was rolled back", async () => {
    let cancelled = false;
    const query = vi.fn().mockResolvedValueOnce(object()).mockResolvedValueOnce(object({ status: "VALID" })).mockResolvedValueOnce(noErrors());
    const value = await compileOracleObject({ databaseType: "oracle", target, query, cancelled: () => cancelled, execute: async () => { cancelled = true; return true; } });
    expect(value).toMatchObject({ outcome: "cancelled", statement_sent: true, object: { status: "VALID" } });
  });
});
