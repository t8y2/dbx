import { describe, expect, it } from "vitest";
import { executionCandidateForMode, resolveExecutableSql, type SqlExecutionCandidate } from "@/lib/sql/sqlExecutionTarget";

function candidate(kind: SqlExecutionCandidate["kind"], supportedKinds: SqlExecutionCandidate["supportedKinds"]): SqlExecutionCandidate {
  return { kind, supportedKinds, label: kind, sql: "SELECT 1", from: 0, to: 8 };
}

describe("resolveExecutableSql", () => {
  it("uses selected SQL before cursor-mode resolution", () => {
    const sql = "select 1;\n\nselect 2;";
    const selectedSql = " select 2; ";
    const cursorAfterFirstSemicolon = sql.indexOf(";") + 1;

    expect(resolveExecutableSql(sql, selectedSql, { mode: "current", cursorPos: cursorAfterFirstSemicolon })).toBe("select 2;");
  });

  it("keeps a manually selected proxy directive unchanged", () => {
    const selectedSql = "/*proxy*/\nSHOW PROXY STATUS";

    expect(resolveExecutableSql("SELECT 1;", selectedSql, { mode: "current", cursorPos: 0 })).toBe(selectedSql);
  });
});

describe("executionCandidateForMode", () => {
  it("does not fall back to all SQL when current mode has no cursor statement", () => {
    const all = candidate("all", ["all"]);

    expect(executionCandidateForMode([all], "current")).toBeNull();
    expect(executionCandidateForMode([all], "all")).toBe(all);
  });

  it("falls back to all SQL only when blank-line execution is enabled", () => {
    const all = candidate("all", ["all"]);

    expect(executionCandidateForMode([all], "current", { executeAllOnBlankLine: false })).toBeNull();
    expect(executionCandidateForMode([all], "current", { executeAllOnBlankLine: true })).toBe(all);
  });

  it("uses the deduplicated candidate when one statement is both current and all", () => {
    const currentAndAll = candidate("all", ["cursor", "all"]);

    expect(executionCandidateForMode([currentAndAll], "current")).toBe(currentAndAll);
    expect(executionCandidateForMode([currentAndAll], "all")).toBe(currentAndAll);
  });

  it("selects the exact target when current and all candidates are distinct", () => {
    const current = candidate("cursor", ["cursor"]);
    const all = candidate("all", ["all"]);

    expect(executionCandidateForMode([current, all], "current")).toBe(current);
    expect(executionCandidateForMode([current, all], "all")).toBe(all);
  });
});
