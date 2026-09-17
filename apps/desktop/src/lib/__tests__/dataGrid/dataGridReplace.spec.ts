import { describe, expect, it } from "vitest";
import { findDataGridReplacementMatches, replaceDataGridText } from "@/lib/dataGrid/dataGridReplace";

describe("data grid searched text replacement", () => {
  it("replaces repeated JSON fragments without changing the rest of the value", () => {
    const value = '[{"backend":"svc.test-test:80","path":"/api/**"},{"backend":"svc2.test-test:81"}]';
    expect(replaceDataGridText(value, "test-test", "prod", false)).toBe('[{"backend":"svc.prod:80","path":"/api/**"},{"backend":"svc2.prod:81"}]');
  });

  it("treats both search and replacement as literals", () => {
    expect(replaceDataGridText("a.* a.*", ".*", "$&$1", false)).toBe("a$&$1 a$&$1");
    expect(replaceDataGridText("one\\two", "\\", "$'", false)).toBe("one$'two");
  });

  it("supports case sensitivity, whitespace searches and empty replacement strings", () => {
    expect(replaceDataGridText("TEST test", "test", "x", true)).toBe("TEST x");
    expect(replaceDataGridText("TEST test", "test", "x", false)).toBe("x x");
    expect(replaceDataGridText("  a  ", "  ", "", false)).toBe("a");
    expect(replaceDataGridText("hit", "hit", "", false)).toBe("");
    expect(replaceDataGridText("hit", "", "x", false)).toBe("hit");
  });

  const rows = [
    { rowId: 7, data: ["hit", null, 123, true, "HIT"] },
    { rowId: 2, data: ["hit", "hit", "none", false, "hit"] },
  ];

  it("matches only string cells in loaded rows using stable source IDs", () => {
    expect(findDataGridReplacementMatches({ rows, search: "hit" })).toEqual([
      { rowId: 7, col: 0, value: "hit" },
      { rowId: 7, col: 4, value: "HIT" },
      { rowId: 2, col: 0, value: "hit" },
      { rowId: 2, col: 1, value: "hit" },
      { rowId: 2, col: 4, value: "hit" },
    ]);
  });

  it("applies column, selection, case, readonly and truncation restrictions before matching", () => {
    expect(findDataGridReplacementMatches({ rows, search: "hit", caseSensitive: true, column: 4 })).toEqual([{ rowId: 2, col: 4, value: "hit" }]);
    expect(findDataGridReplacementMatches({ rows, search: "hit", includesCell: (rowId, col) => rowId === 2 && col === 1 })).toEqual([{ rowId: 2, col: 1, value: "hit" }]);
    expect(findDataGridReplacementMatches({ rows, search: "hit", canReplaceCell: (rowId, col) => rowId !== 7 && col !== 1, isTruncated: (rowId, col) => rowId === 2 && col === 4 })).toEqual([{ rowId: 2, col: 0, value: "hit" }]);
    expect(findDataGridReplacementMatches({ rows, search: "hit", includesCell: () => false })).toEqual([]);
    expect(findDataGridReplacementMatches({ rows, search: "" })).toEqual([]);
  });
});
