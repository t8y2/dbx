import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDataGridCellDetail,
  buildDataGridColumnDetail,
  dataGridColumnDetailJson,
  dataGridColumnDetailTsv,
  buildDataGridRowDetail,
  dataGridRowDetailJson,
  dataGridRowDetailTsv,
} from "../../apps/desktop/src/lib/dataGridDetail.ts";
import type { CellValue } from "../../apps/desktop/src/lib/cellValue.ts";

test("buildDataGridCellDetail returns null for an invalid column", () => {
  const detail = buildDataGridCellDetail({
    rowIndex: 0,
    rowId: 10,
    row: ["Ada"],
    columns: ["name"],
    columnIndex: 2,
    displayValue: (value) => String(value),
    isEditable: false,
  });

  assert.equal(detail, null);
});

test("buildDataGridCellDetail preserves full value metadata", () => {
  const typeByColumn = new Map([["payload", "jsonb"]]);
  const commentByColumn = new Map([["payload", "raw event payload"]]);
  const detail = buildDataGridCellDetail({
    rowIndex: 2,
    rowId: 42,
    row: [7, '{"ok":true,"items":[1,2]}'],
    columns: ["id", "payload"],
    columnIndex: 1,
    typeByColumn,
    commentByColumn,
    displayValue: (value) => `formatted:${String(value).slice(0, 8)}`,
    isEditable: true,
  });

  assert.deepEqual(detail, {
    rowNumber: 3,
    rowId: 42,
    colIndex: 1,
    column: "payload",
    type: "jsonb",
    comment: "raw event payload",
    value: '{"ok":true,"items":[1,2]}',
    rawValue: '{"ok":true,"items":[1,2]}',
    rawValuePreview: '{"ok":true,"items":[1,2]}',
    displayValue: 'formatted:{"ok":tr',
    displayValuePreview: 'formatted:{"ok":tr',
    isValuePreviewTruncated: false,
    imagePreviewUrl: null,
    length: 25,
    formattedJson: '{\n  "ok": true,\n  "items": [\n    1,\n    2\n  ]\n}',
    isEditable: true,
  });
});

test("buildDataGridCellDetail reports image preview URLs", () => {
  const detail = buildDataGridCellDetail({
    rowIndex: 0,
    rowId: 1,
    row: ["https://example.com/avatar.png"],
    columns: ["avatar"],
    columnIndex: 0,
    displayValue: (value) => String(value),
    isEditable: false,
  });

  assert.equal(detail?.imagePreviewUrl, "https://example.com/avatar.png");
});

test("buildDataGridCellDetail limits rendered previews for huge text values", () => {
  const hugeJson = `{"body":"${"x".repeat(120_000)}"}`;
  const detail = buildDataGridCellDetail({
    rowIndex: 0,
    rowId: 1,
    row: [hugeJson],
    columns: ["payload"],
    columnIndex: 0,
    typeByColumn: new Map([["payload", "nvarchar(max)"]]),
    displayValue: (value) => String(value),
    isEditable: false,
  });

  assert.ok(detail);
  assert.equal(detail.rawValue, hugeJson);
  assert.equal(detail.rawValuePreview.length, 12_000);
  assert.equal(detail.displayValuePreview.length, 12_000);
  assert.equal(detail.isValuePreviewTruncated, true);
  assert.equal(detail.formattedJson, "");
});

test("buildDataGridRowDetail maps requested column indexes in order", () => {
  const row: CellValue[] = ["Ada", null, true];
  const detail = buildDataGridRowDetail({
    rowIndex: 4,
    rowId: 99,
    row,
    columns: ["name", "nickname", "active"],
    columnIndexes: [2, 0, 1],
    displayValue: (value) => (value === null ? "NULL" : String(value)),
    isEditableColumn: (columnIndex) => columnIndex !== 2,
  });

  assert.equal(detail.rowNumber, 5);
  assert.equal(detail.rowId, 99);
  assert.deepEqual(
    detail.fields.map((field) => ({
      column: field.column,
      colIndex: field.colIndex,
      rawValue: field.rawValue,
      isEditable: field.isEditable,
    })),
    [
      { column: "active", colIndex: 2, rawValue: "true", isEditable: false },
      { column: "name", colIndex: 0, rawValue: "Ada", isEditable: true },
      { column: "nickname", colIndex: 1, rawValue: "NULL", isEditable: true },
    ],
  );
});

test("buildDataGridRowDetail keeps duplicate columns as separate fields", () => {
  const detail = buildDataGridRowDetail({
    rowIndex: 0,
    rowId: 1,
    row: ["first", "second"],
    columns: ["name", "name"],
    columnIndexes: [0, 1],
    displayValue: (value) => String(value),
  });

  assert.deepEqual(
    detail.fields.map((field) => [field.colIndex, field.column, field.rawValue]),
    [
      [0, "name", "first"],
      [1, "name", "second"],
    ],
  );
});

test("dataGridRowDetailJson and dataGridRowDetailTsv format copy payloads", () => {
  const detail = buildDataGridRowDetail({
    rowIndex: 0,
    rowId: 1,
    row: [1, "Ada", null],
    columns: ["id", "name", "nickname"],
    columnIndexes: [0, 1, 2],
    displayValue: (value) => (value === null ? "NULL" : String(value)),
  });

  assert.equal(dataGridRowDetailJson(detail), '{\n  "id": 1,\n  "name": "Ada",\n  "nickname": null\n}');
  assert.equal(dataGridRowDetailTsv(detail), "1\tAda\tNULL");
});

test("buildDataGridColumnDetail maps a whole column across rows", () => {
  const typeByColumn = new Map([["name", "varchar"]]);
  const commentByColumn = new Map([["name", "display name"]]);
  const detail = buildDataGridColumnDetail({
    rows: [
      { rowIndex: 0, rowId: 10, row: [1, "Ada"], isEditable: true },
      { rowIndex: 3, rowId: 13, row: [4, null], isEditable: false },
    ],
    columns: ["id", "name"],
    columnIndex: 1,
    typeByColumn,
    commentByColumn,
    displayValue: (value) => (value === null ? "NULL" : String(value)),
  });

  assert.equal(detail?.column, "name");
  assert.equal(detail?.type, "varchar");
  assert.equal(detail?.comment, "display name");
  assert.deepEqual(
    detail?.fields.map((field) => ({
      rowNumber: field.rowNumber,
      rowId: field.rowId,
      rawValue: field.rawValue,
      isEditable: field.isEditable,
    })),
    [
      { rowNumber: 1, rowId: 10, rawValue: "Ada", isEditable: true },
      { rowNumber: 4, rowId: 13, rawValue: "NULL", isEditable: false },
    ],
  );
});

test("buildDataGridColumnDetail returns null for an invalid column", () => {
  const detail = buildDataGridColumnDetail({
    rows: [{ rowIndex: 0, rowId: 1, row: ["Ada"] }],
    columns: ["name"],
    columnIndex: 3,
    displayValue: (value) => String(value),
  });

  assert.equal(detail, null);
});

test("dataGridColumnDetailJson and dataGridColumnDetailTsv format copy payloads", () => {
  const detail = buildDataGridColumnDetail({
    rows: [
      { rowIndex: 0, rowId: 1, row: [1, "Ada"] },
      { rowIndex: 1, rowId: 2, row: [2, null] },
    ],
    columns: ["id", "name"],
    columnIndex: 1,
    displayValue: (value) => (value === null ? "NULL" : String(value)),
  });

  assert.ok(detail);
  assert.equal(
    dataGridColumnDetailJson(detail),
    '[\n  {\n    "row": 1,\n    "value": "Ada"\n  },\n  {\n    "row": 2,\n    "value": null\n  }\n]',
  );
  assert.equal(dataGridColumnDetailTsv(detail), "Ada\nNULL");
});
