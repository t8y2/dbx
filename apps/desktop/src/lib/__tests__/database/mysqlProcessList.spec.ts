import { describe, expect, it } from "vitest";
import type { QueryResult } from "@/types/database";
import { buildKillSql, clampInterval, createProcessListLoadCoordinator, mapProcessRows, processListExecutionError, processListSessionCount, supportsProcessList } from "@/lib/database/mysqlProcessList";

function result(columns: string[], rows: (string | number | boolean | null)[][]): QueryResult {
  return { columns, rows, affected_rows: 0, execution_time_ms: 0 };
}

describe("mapProcessRows", () => {
  it("maps a SHOW FULL PROCESSLIST result into typed rows", () => {
    const rows = mapProcessRows(result(["Id", "User", "Host", "db", "Command", "Time", "State", "Info"], [[8213, "app", "10.0.0.4:5123", "shop", "Query", 12, "Sending data", "SELECT * FROM orders"]]));
    expect(rows).toEqual([
      {
        id: 8213,
        user: "app",
        host: "10.0.0.4:5123",
        db: "shop",
        command: "Query",
        time: 12,
        state: "Sending data",
        info: "SELECT * FROM orders",
      },
    ]);
  });

  it("tolerates NULL db/state/info and case-variant column names", () => {
    const rows = mapProcessRows(result(["ID", "USER", "HOST", "DB", "COMMAND", "TIME", "STATE", "INFO"], [["8199", "root", "localhost", null, "Sleep", "340", null, null]]));
    expect(rows[0]).toMatchObject({ id: 8199, user: "root", db: null, state: null, info: null, time: 340 });
  });

  it("returns an empty array for empty or malformed input", () => {
    expect(mapProcessRows(null)).toEqual([]);
    expect(mapProcessRows(undefined)).toEqual([]);
    expect(mapProcessRows(result([], []))).toEqual([]);
  });
});

describe("buildKillSql", () => {
  it("builds KILL CONNECTION for a valid id", () => {
    expect(buildKillSql(8213)).toBe("KILL CONNECTION 8213");
  });

  it("rejects non-integer or negative ids", () => {
    expect(() => buildKillSql(1.5)).toThrow();
    expect(() => buildKillSql(-1)).toThrow();
    expect(() => buildKillSql(Number.NaN)).toThrow();
  });
});

describe("clampInterval", () => {
  it("clamps below the minimum to 1 second", () => {
    expect(clampInterval(0)).toBe(1);
    expect(clampInterval(-5)).toBe(1);
  });

  it("caps at the maximum", () => {
    expect(clampInterval(999999)).toBe(3600);
  });

  it("floors fractional seconds and falls back for non-finite input", () => {
    expect(clampInterval(4.9)).toBe(4);
    expect(clampInterval(Number.NaN)).toBe(5);
  });
});

describe("createProcessListLoadCoordinator", () => {
  it("prevents overlapping manual and timer-driven refreshes", () => {
    const coordinator = createProcessListLoadCoordinator();
    expect(coordinator.tryStart()).toBe(true);
    expect(coordinator.tryStart()).toBe(false);
    coordinator.finish();
    expect(coordinator.tryStart()).toBe(true);
  });
});

describe("processListExecutionError", () => {
  it("returns the message from a synthesized execution error", () => {
    expect(processListExecutionError([{ ...result(["Error"], [["command denied"]]), execution_error: true }])).toBe("command denied");
  });

  it("does not treat a successful Error column as a failure", () => {
    expect(processListExecutionError([result(["Error"], [["application value"]])])).toBeNull();
  });
});

describe("processListSessionCount", () => {
  it("marks truncated counts as a lower bound", () => {
    expect(processListSessionCount(5000, true)).toBe("5000+");
    expect(processListSessionCount(42, false)).toBe(42);
  });
});

describe("supportsProcessList", () => {
  it("is limited to connections using the MySQL driver type", () => {
    expect(supportsProcessList("mysql")).toBe(true);
    expect(supportsProcessList("doris")).toBe(false);
    expect(supportsProcessList("starrocks")).toBe(false);
    expect(supportsProcessList("goldendb")).toBe(false);
    expect(supportsProcessList("postgres")).toBe(false);
    expect(supportsProcessList("sqlite")).toBe(false);
    expect(supportsProcessList(undefined)).toBe(false);
  });
});
