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

  it("keeps a manually selected same-line TDSQL directive unchanged", () => {
    const selectedSql = "/*sets:allsets */ SELECT count(*) FROM tenant_table";

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

  // #15213: nested candidates arrive innermost-first, but "current" mode must
  // keep its historical meaning — the outermost statement at the cursor.
  it("keeps current mode on the outermost statement when nested candidates exist", () => {
    const nestedInner = candidate("nested", ["nested"]);
    nestedInner.sql = "SELECT 1";
    const nestedMiddle = candidate("nested", ["nested"]);
    nestedMiddle.sql = "SELECT * FROM (SELECT 1)";
    const outer = candidate("cursor", ["cursor"]);
    outer.sql = "INSERT INTO t SELECT * FROM (SELECT 1) s";

    const candidates = [nestedInner, nestedMiddle, outer];
    expect(executionCandidateForMode(candidates, "current")?.sql).toBe(outer.sql);
    expect(executionCandidateForMode(candidates, "all")).toBeNull();
  });

  it("keeps the historical single-candidate current behavior without nesting", () => {
    const both = candidate("cursor", ["cursor", "all"]);
    expect(executionCandidateForMode([both], "current")).toBe(both);
    expect(executionCandidateForMode([both], "all")).toBe(both);
  });
});
