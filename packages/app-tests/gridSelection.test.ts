import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  allCellsSelectionRange,
  columnSelectionRange,
  extractColumnsSelection,
  extractSelection,
  formatSelectionAsCsv,
  formatSelectionAsJson,
  formatSelectionAsSqlInList,
  formatSelectionAsTsv,
  isCellInSelection,
  normalizeSelectionRange,
  parseClipboardTable,
  rowSelectionRange,
} from "../../apps/desktop/src/lib/gridSelection.ts";

test("normalizes a dragged cell range in either direction", () => {
  const range = normalizeSelectionRange({ rowIndex: 4, colIndex: 3 }, { rowIndex: 1, colIndex: 0 });

  assert.deepEqual(range, {
    startRow: 1,
    endRow: 4,
    startCol: 0,
    endCol: 3,
  });
  assert.equal(isCellInSelection(2, 1, range), true);
  assert.equal(isCellInSelection(5, 1, range), false);
});

test("extracts selection rows and columns from a rectangular range", () => {
  const selection = extractSelection(
    ["id", "name", "active"],
    [
      [1, "Ada", true],
      [2, "Linus", false],
      [3, null, true],
    ],
    { startRow: 0, endRow: 1, startCol: 1, endCol: 2 },
  );

  assert.deepEqual(selection.columns, ["name", "active"]);
  assert.deepEqual(selection.rows, [
    ["Ada", true],
    ["Linus", false],
  ]);
});

test("extracts non-contiguous columns in display order", () => {
  const selection = extractColumnsSelection(
    ["id", "name", "active", "email"],
    [
      [1, "Ada", true, "ada@example.com"],
      [2, "Linus", false, "linus@example.com"],
    ],
    [3, 1, 3],
  );

  assert.deepEqual(selection.columns, ["name", "email"]);
  assert.deepEqual(selection.rows, [
    ["Ada", "ada@example.com"],
    ["Linus", "linus@example.com"],
  ]);
});

test("builds whole row, column, and table selection ranges", () => {
  assert.deepEqual(rowSelectionRange(2, 4), { startRow: 2, endRow: 2, startCol: 0, endCol: 3 });
  assert.deepEqual(rowSelectionRange(4, 4, 2), { startRow: 2, endRow: 4, startCol: 0, endCol: 3 });
  assert.deepEqual(columnSelectionRange(5, 1), { startRow: 0, endRow: 4, startCol: 1, endCol: 1 });
  assert.deepEqual(columnSelectionRange(5, 3, 1), { startRow: 0, endRow: 4, startCol: 1, endCol: 3 });
  assert.deepEqual(allCellsSelectionRange(3, 2), { startRow: 0, endRow: 2, startCol: 0, endCol: 1 });
  assert.equal(rowSelectionRange(0, 0), null);
  assert.equal(columnSelectionRange(0, 0), null);
  assert.equal(allCellsSelectionRange(0, 2), null);
});

test("formats selected cells as TSV, CSV, JSON, and SQL values", () => {
  const selection = {
    columns: ["name", "note"],
    rows: [
      ["Ada", "math"],
      ["Bob", 'quote "here"'],
      ["O'Hara", null],
    ],
  };

  assert.equal(formatSelectionAsTsv(selection), 'Ada\tmath\nBob\tquote "here"\nO\'Hara\tNULL');
  assert.equal(formatSelectionAsCsv(selection), '"name","note"\n"Ada","math"\n"Bob","quote ""here"""\n"O\'Hara","NULL"');
  assert.equal(
    formatSelectionAsJson(selection),
    JSON.stringify(
      [
        { name: "Ada", note: "math" },
        { name: "Bob", note: 'quote "here"' },
        { name: "O'Hara", note: null },
      ],
      null,
      2,
    ),
  );
  assert.equal(formatSelectionAsSqlInList(selection), "('Ada', 'math', 'Bob', 'quote \"here\"', 'O''Hara', NULL)");
});

test("parses clipboard table text with spreadsheet line endings", () => {
  assert.deepEqual(parseClipboardTable("0"), [["0"]]);
  assert.deepEqual(parseClipboardTable("a\tb\r\nc\td\r\n"), [
    ["a", "b"],
    ["c", "d"],
  ]);
});
