import { describe, expect, it } from "vitest";
import { resolveExecutableSql } from "../sqlExecutionTarget";

describe("resolveExecutableSql", () => {
  it("uses selected SQL before cursor-mode resolution", () => {
    const sql = "select 1;\n\nselect 2;";
    const selectedSql = " select 2; ";
    const cursorAfterFirstSemicolon = sql.indexOf(";") + 1;

    expect(resolveExecutableSql(sql, selectedSql, { mode: "current", cursorPos: cursorAfterFirstSemicolon })).toBe("select 2;");
  });
});
