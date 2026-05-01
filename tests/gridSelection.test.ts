import { strict as assert } from "node:assert";
import test from "node:test";
import {
  extractSelection,
  formatSelectionAsCsv,
  formatSelectionAsJson,
  formatSelectionAsSqlInList,
  formatSelectionAsTsv,
  isCellInSelection,
  normalizeSelectionRange,
} from "../src/lib/gridSelection.ts";

test("normalizes a dragged cell range in either direction", () => {
  const range = normalizeSelectionRange(
    { rowIndex: 4, colIndex: 3 },
    { rowIndex: 1, colIndex: 0 },
  );

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

test("formats selected cells as TSV, CSV, JSON, and SQL values", () => {
  const selection = {
    columns: ["name", "note"],
    rows: [
      ["Ada", "math"],
      ["Bob", "quote \"here\""],
      ["O'Hara", null],
    ],
  };

  assert.equal(formatSelectionAsTsv(selection), "name\tnote\nAda\tmath\nBob\tquote \"here\"\nO'Hara\tNULL");
  assert.equal(formatSelectionAsCsv(selection), "\"name\",\"note\"\n\"Ada\",\"math\"\n\"Bob\",\"quote \"\"here\"\"\"\n\"O'Hara\",\"NULL\"");
  assert.equal(
    formatSelectionAsJson(selection),
    JSON.stringify([
      { name: "Ada", note: "math" },
      { name: "Bob", note: "quote \"here\"" },
      { name: "O'Hara", note: null },
    ], null, 2),
  );
  assert.equal(formatSelectionAsSqlInList(selection), "('Ada', 'math', 'Bob', 'quote \"here\"', 'O''Hara', NULL)");
});
