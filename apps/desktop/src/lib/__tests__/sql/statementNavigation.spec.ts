import { describe, expect, it } from "vitest";
import { executableStatementRanges, type SqlTextRange } from "@/lib/sql/sqlStatementRanges";
import { statementNavigationTarget } from "@/lib/sql/statementNavigation";

const SQL = ["SELECT 1;", "", "SELECT 2", "FROM t;", "", "UPDATE t SET x = 1;"].join("\n");

function range(from: number, to: number, sql = ""): SqlTextRange {
  return { from, to, sql };
}

describe("statementNavigationTarget", () => {
  const ranges = executableStatementRanges(SQL, "postgres");
  const first = SQL.indexOf("SELECT 1");
  const second = SQL.indexOf("SELECT 2");
  const third = SQL.indexOf("UPDATE t");

  it("parses the fixture into three executable statements", () => {
    expect(ranges).toHaveLength(3);
    expect(ranges.map((item) => item.from)).toEqual([first, second, third]);
  });

  it("moves to the next statement from its start or from inside it", () => {
    expect(statementNavigationTarget(ranges, first, "next")).toBe(second);
    expect(statementNavigationTarget(ranges, first + 3, "next")).toBe(second);
    expect(statementNavigationTarget(ranges, second, "next")).toBe(third);
  });

  it("has nowhere to go from the last statement", () => {
    expect(statementNavigationTarget(ranges, third, "next")).toBeNull();
    expect(statementNavigationTarget(ranges, SQL.length, "next")).toBeNull();
  });

  it("moves to the current statement start first when going back", () => {
    expect(statementNavigationTarget(ranges, second + 5, "previous")).toBe(second);
    expect(statementNavigationTarget(ranges, second, "previous")).toBe(first);
    expect(statementNavigationTarget(ranges, third + 2, "previous")).toBe(third);
  });

  it("has nowhere to go before the first statement", () => {
    expect(statementNavigationTarget(ranges, first, "previous")).toBeNull();
    expect(statementNavigationTarget(ranges, 0, "previous")).toBeNull();
  });

  it("jumps to the start of the statement under the caret", () => {
    expect(statementNavigationTarget(ranges, second + 7, "start")).toBe(second);
    expect(statementNavigationTarget(ranges, third + 1, "start")).toBe(third);
    expect(statementNavigationTarget(ranges, second, "start")).toBeNull();
  });

  it("resolves the blank line between two statements to the following one", () => {
    const gap = ranges[0].to + 1;
    expect(gap).toBeGreaterThan(first);
    expect(gap).toBeLessThan(second);
    expect(statementNavigationTarget(ranges, gap, "start")).toBe(second);
    expect(statementNavigationTarget(ranges, gap, "next")).toBe(second);
    // Going back from the gap lands on the statement that just ended.
    expect(statementNavigationTarget(ranges, gap, "previous")).toBe(first);
  });

  it("falls back to the first statement when the caret precedes all ranges", () => {
    const leading = [range(10, 20)];
    expect(statementNavigationTarget(leading, 2, "next")).toBe(10);
    expect(statementNavigationTarget(leading, 2, "start")).toBe(10);
    expect(statementNavigationTarget(leading, 2, "previous")).toBeNull();
  });

  it("returns null without statements", () => {
    expect(statementNavigationTarget([], 0, "next")).toBeNull();
    expect(statementNavigationTarget([], 0, "previous")).toBeNull();
    expect(statementNavigationTarget([], 0, "start")).toBeNull();
  });
});
