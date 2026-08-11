import { describe, expect, it } from "vitest";
import { getSqlFunctionSignatureHelp } from "@/lib/sql/sqlCompletion";

describe("ClickHouse signature help", () => {
  it("returns every overload and highlights the active ordinary parameter", () => {
    const sql = "SELECT toStartOfInterval(ts, ";
    const help = getSqlFunctionSignatureHelp(sql, sql.length, "clickhouse");
    expect(help?.name).toBe("toStartOfInterval");
    expect(help?.overloads.length).toBeGreaterThan(1);
    expect(help?.overloads[0].activeGroup).toBe(0);
    expect(help?.overloads[0].activeParameter).toBe(1);
  });

  it("resolves the second parameter group of a parametric aggregate", () => {
    const sql = "SELECT quantilesTDigest(0.5, 0.9)(value";
    const help = getSqlFunctionSignatureHelp(sql, sql.length, "clickhouse");
    expect(help?.name).toBe("quantilesTDigest");
    expect(help?.overloads[0]).toMatchObject({ activeGroup: 1, activeParameter: 0 });
    expect(help?.overloads[0].parameterGroups).toEqual([["level", "...levels"], ["expression"]]);
  });

  it("keeps MySQL signature help as one overload and one parameter group", () => {
    const sql = "SELECT DATE_ADD(created_at, ";
    const help = getSqlFunctionSignatureHelp(sql, sql.length, "mysql");
    expect(help?.overloads).toHaveLength(1);
    expect(help?.overloads[0].parameterGroups).toEqual([["date", "INTERVAL expr unit"]]);
  });

  it("adds Dolt signature help only for the Dolt profile", () => {
    const sql = "CALL DOLT_MERGE_BASE('main', ";
    expect(getSqlFunctionSignatureHelp(sql, sql.length, "mysql", "mysql")).toBeNull();

    const help = getSqlFunctionSignatureHelp(sql, sql.length, "mysql", "dolt");
    expect(help?.name).toBe("DOLT_MERGE_BASE");
    expect(help?.parameters).toEqual(["revision_a", "revision_b"]);
    expect(help?.activeParameter).toBe(1);
  });
});
