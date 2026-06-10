import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  buildTransposeRows,
  buildVisibleTransposeRows,
  transposeRecordIndexesForMode,
  nextContextTransposeState,
  nextAppendedTransposeState,
  nextKeyboardTransposeState,
  nextTransposeState,
  nextTransposeStateForRecordCount,
  transposeAnchorRowIndex,
  transposeFieldWidth,
  transposeScrollLeftForRecord,
  visibleTransposeRecordWindow,
} from "../../apps/desktop/src/lib/dataGridTranspose.ts";

test("row number double click opens transpose for a row", () => {
  assert.deepEqual(nextTransposeState(false, null, 2), {
    showTranspose: true,
    transposeRowIndex: 2,
  });
});

test("row number double click switches transpose to another row", () => {
  assert.deepEqual(nextTransposeState(true, 2, 4), {
    showTranspose: true,
    transposeRowIndex: 4,
  });
});

test("row number double click closes transpose for the same row", () => {
  assert.deepEqual(nextTransposeState(true, 2, 2), {
    showTranspose: false,
    transposeRowIndex: null,
  });
});

test("context menu transpose closes when invoked for the current anchor row", () => {
  assert.deepEqual(
    nextContextTransposeState({
      showTranspose: true,
      transposeRowIndex: 2,
      requestedRowIndex: 3,
      rowIds: [10, 11, 12, 13, 14],
      selectedRowIds: new Set([12, 13]),
      selectedRange: null,
    }),
    {
      showTranspose: false,
      transposeRowIndex: null,
    },
  );
});

test("builds one virtualizable transpose row per field with all record values", () => {
  const rows = buildTransposeRows({
    columns: ["id", "name", "notes"],
    records: [
      [1, "Ada", null],
      [2, "Grace", "compiler"],
    ],
    typeByColumn: new Map([
      ["id", "int"],
      ["name", "varchar"],
    ]),
    displayValue: (value) => (value === null ? "NULL" : String(value)),
  });

  assert.deepEqual(rows, [
    {
      id: "0:id",
      column: "id",
      type: "int",
      values: [
        { value: 1, display: "1", isNull: false },
        { value: 2, display: "2", isNull: false },
      ],
    },
    {
      id: "1:name",
      column: "name",
      type: "varchar",
      values: [
        { value: "Ada", display: "Ada", isNull: false },
        { value: "Grace", display: "Grace", isNull: false },
      ],
    },
    {
      id: "2:notes",
      column: "notes",
      type: "",
      values: [
        { value: null, display: "NULL", isNull: true },
        { value: "compiler", display: "compiler", isNull: false },
      ],
    },
  ]);
});

test("builds transpose rows for only the visible record window", () => {
  const formatted: string[] = [];
  const rows = buildVisibleTransposeRows({
    columns: ["id", "name"],
    records: [
      [1, "Ada"],
      [2, "Grace"],
      [3, "Linus"],
    ],
    recordIndexes: [1, 2],
    displayValue: (value, column, _columnIndex, recordIndex) => {
      formatted.push(`${recordIndex}:${column}`);
      return String(value);
    },
  });

  assert.deepEqual(
    rows.map((row) => ({
      column: row.column,
      values: row.values.map((cell) => ({ recordIndex: cell.recordIndex, display: cell.display })),
    })),
    [
      {
        column: "id",
        values: [
          { recordIndex: 1, display: "2" },
          { recordIndex: 2, display: "3" },
        ],
      },
      {
        column: "name",
        values: [
          { recordIndex: 1, display: "Grace" },
          { recordIndex: 2, display: "Linus" },
        ],
      },
    ],
  );
  assert.deepEqual(formatted, ["1:id", "2:id", "1:name", "2:name"]);
});

test("builds visible transpose rows from mapped source column indexes", () => {
  const rows = buildVisibleTransposeRows({
    columns: ["name"],
    records: [
      [1, "Ada"],
      [2, "Grace"],
    ],
    recordIndexes: [0],
    valueIndexes: [1],
    displayValue: (value) => String(value),
  });

  assert.equal(rows[0].values[0].display, "Ada");
  assert.equal(rows[0].values[0].valueIndex, 1);
});

test("single-row transpose only includes the active record", () => {
  assert.deepEqual(
    transposeRecordIndexesForMode({
      multiRow: false,
      activeRecordIndex: 3,
      totalRecords: 10,
      visibleRecordIndexes: [1, 2, 3, 4],
    }),
    [3],
  );
});

test("single-row transpose clamps the active record into range", () => {
  assert.deepEqual(
    transposeRecordIndexesForMode({
      multiRow: false,
      activeRecordIndex: 12,
      totalRecords: 10,
      visibleRecordIndexes: [7, 8, 9],
    }),
    [9],
  );
});

test("multi-row transpose keeps the visible record window", () => {
  assert.deepEqual(
    transposeRecordIndexesForMode({
      multiRow: true,
      activeRecordIndex: 3,
      totalRecords: 10,
      visibleRecordIndexes: [1, 2, 3, 4],
    }),
    [1, 2, 3, 4],
  );
});

test("keyboard transpose opens from the selected cell row and closes when active", () => {
  assert.deepEqual(
    nextKeyboardTransposeState({
      showTranspose: false,
      transposeRowIndex: null,
      requestedRowIndex: 3,
      rowIds: [10, 11, 12, 13, 14],
      selectedRowIds: new Set(),
      selectedRange: null,
    }),
    {
      showTranspose: true,
      transposeRowIndex: 3,
    },
  );

  assert.deepEqual(
    nextKeyboardTransposeState({
      showTranspose: true,
      transposeRowIndex: 3,
      requestedRowIndex: 3,
      rowIds: [10, 11, 12, 13, 14],
      selectedRowIds: new Set(),
      selectedRange: null,
    }),
    {
      showTranspose: false,
      transposeRowIndex: null,
    },
  );
});

test("transpose follows appended rows when already open", () => {
  assert.deepEqual(nextAppendedTransposeState(true, 4), {
    showTranspose: true,
    transposeRowIndex: 3,
  });
  assert.deepEqual(nextAppendedTransposeState(false, 4), {
    showTranspose: false,
    transposeRowIndex: null,
  });
});

test("transpose state is preserved and clamped after record refresh", () => {
  assert.deepEqual(nextTransposeStateForRecordCount(true, 4, 3), {
    showTranspose: true,
    transposeRowIndex: 2,
  });
  assert.deepEqual(nextTransposeStateForRecordCount(true, 1, 0), {
    showTranspose: false,
    transposeRowIndex: null,
  });
});

test("calculates a horizontal record window with spacer widths", () => {
  assert.deepEqual(
    visibleTransposeRecordWindow({
      totalRecords: 100,
      scrollLeft: 680,
      viewportWidth: 720,
      pinnedWidth: 320,
      recordWidth: 160,
      overscan: 1,
    }),
    {
      start: 1,
      end: 7,
      beforeWidth: 160,
      afterWidth: 14880,
    },
  );
});

test("uses the first selected row as the transpose anchor when context row is inside row selection", () => {
  assert.equal(
    transposeAnchorRowIndex({
      requestedRowIndex: 3,
      rowIds: [10, 11, 12, 13, 14, 15],
      selectedRowIds: new Set([12, 13, 14]),
      selectedRange: null,
    }),
    2,
  );
});

test("uses the first selected cell range row as the transpose anchor when context row is inside range", () => {
  assert.equal(
    transposeAnchorRowIndex({
      requestedRowIndex: 5,
      rowIds: [10, 11, 12, 13, 14, 15],
      selectedRowIds: new Set(),
      selectedRange: { startRow: 2, endRow: 5, startCol: 0, endCol: 2 },
    }),
    2,
  );
});

test("sizes the transpose field column from visible field names", () => {
  assert.equal(transposeFieldWidth(["id", "iso3", "year"]), 104);
  assert.equal(transposeFieldWidth(["country_name"]), 128);
});

test("caps the transpose field column width for long field names", () => {
  assert.equal(transposeFieldWidth(["a_very_long_metric_column_name"]), 220);
});

test("aligns the selected transpose record at the start of the scrollable records", () => {
  assert.equal(
    transposeScrollLeftForRecord({
      recordIndex: 55,
      totalRecords: 100,
      viewportWidth: 1200,
      pinnedWidth: 104,
      recordWidth: 168,
    }),
    9240,
  );
});
