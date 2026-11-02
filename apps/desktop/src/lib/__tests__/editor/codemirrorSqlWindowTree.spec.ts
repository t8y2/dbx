import { describe, expect, it, vi } from "vitest";
import * as langSql from "@codemirror/lang-sql";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
import { createSqlWindowTreeParser } from "@/lib/editor/codemirrorSqlWindowTree";
import { statementsOverlapping } from "@/components/editor/useQueryEditorStatementBoundaries";

function nodeNames(tree: ReturnType<ReturnType<typeof createSqlWindowTreeParser>>): Set<string> {
  const names = new Set<string>();
  tree.iterate({ enter: (node) => void names.add(node.name) });
  return names;
}

describe("createSqlWindowTreeParser", () => {
  it("parses a bounded piece of SQL with the full Lezer grammar", () => {
    const parse = createSqlWindowTreeParser(langSql, { key: () => "mysql", dialect: () => createDbxCodeMirrorSqlDialect(langSql, "mysql", "mysql") });
    const names = nodeNames(parse("SELECT 'a' FROM (SELECT 1) t -- c"));
    expect(names).toContain("Statement");
    expect(names).toContain("Parens");
    expect(names).toContain("String");
    expect(names).toContain("LineComment");
  });

  it("builds the dialect once per key and rebuilds when the key changes", () => {
    const dialect = vi.fn(() => createDbxCodeMirrorSqlDialect(langSql, "mysql", "mysql"));
    let key = "a";
    const parse = createSqlWindowTreeParser(langSql, { key: () => key, dialect });
    parse("SELECT 1");
    parse("SELECT 2");
    expect(dialect).toHaveBeenCalledTimes(1);
    key = "b";
    parse("SELECT 3");
    expect(dialect).toHaveBeenCalledTimes(2);
  });
});

describe("statementsOverlapping", () => {
  const ranges = [
    { from: 0, to: 9, sql: "" },
    { from: 10, to: 19, sql: "" },
    { from: 20, to: 29, sql: "" },
    { from: 40, to: 49, sql: "" },
  ];

  it("returns only the statements that intersect the span", () => {
    expect(statementsOverlapping(ranges, 12, 15).map((range) => range.from)).toEqual([10]);
    expect(statementsOverlapping(ranges, 18, 22).map((range) => range.from)).toEqual([10, 20]);
    expect(statementsOverlapping(ranges, 0, 100).map((range) => range.from)).toEqual([0, 10, 20, 40]);
  });

  it("returns nothing for gaps and positions outside every statement", () => {
    expect(statementsOverlapping(ranges, 31, 38)).toEqual([]);
    expect(statementsOverlapping(ranges, 60, 70)).toEqual([]);
    expect(statementsOverlapping([], 0, 5)).toEqual([]);
  });
});
