import { MONGO_DOCUMENT_GRID_NULL, mongoDocumentGridDisplayText, mongoDocumentGridExternalValue, mongoDocumentGridValue } from "@/lib/mongo/mongoDocumentValues";
import { displayCellValue, type CellValue } from "@/lib/dataGrid/cellValue";
import { describe, expect, it } from "vitest";
import { buildDataGridCellDetail, buildDataGridColumnDetail, buildDataGridRowDetail, buildDeleteRowConfirmDetails, dataGridColumnDetailJson, dataGridColumnDetailTsv, dataGridRowDetailJson, dataGridRowDetailTsv, type DataGridColumnDetail, type DataGridRowDetail } from "../dataGridDetail";

type TestRow = string[];

function testRowFormatter(row: TestRow, columnIndex: number): string {
  return `FORMATTED(${row[columnIndex]})`;
}

describe("buildDeleteRowConfirmDetails", () => {
  const rows = new Map<number, TestRow>([
    [1, ["1", "Alice"]],
    [2, ["2", "Bob"]],
    [3, ["3", "Carol"]],
  ]);
  const columns = ["id", "name"];
  const getRow = (rowId: number) => rows.get(rowId);

  it("appends a single formatted row line under the header", () => {
    const result = buildDeleteRowConfirmDetails({
      header: "Table: people",
      rowIds: [1],
      columns,
      getRow,
      formatCell: testRowFormatter,
    });

    expect(result).toBe('Table: people\n{"id":"FORMATTED(1)","name":"FORMATTED(Alice)"}');
  });

  it("appends one line per row, in the given order, for multi-row deletes", () => {
    const result = buildDeleteRowConfirmDetails({
      header: "Table: people",
      rowIds: [2, 1, 3],
      columns,
      getRow,
      formatCell: testRowFormatter,
    });

    expect(result).toBe(["Table: people", '{"id":"FORMATTED(2)","name":"FORMATTED(Bob)"}', '{"id":"FORMATTED(1)","name":"FORMATTED(Alice)"}', '{"id":"FORMATTED(3)","name":"FORMATTED(Carol)"}'].join("\n"));
  });

  it("skips row ids that no longer resolve instead of throwing or inserting a blank line", () => {
    const result = buildDeleteRowConfirmDetails({
      header: "Table: people",
      rowIds: [1, 999, 2],
      columns,
      getRow,
      formatCell: testRowFormatter,
    });

    expect(result).toBe(["Table: people", '{"id":"FORMATTED(1)","name":"FORMATTED(Alice)"}', '{"id":"FORMATTED(2)","name":"FORMATTED(Bob)"}'].join("\n"));
  });

  it("falls back to just the header when no rows resolve", () => {
    const result = buildDeleteRowConfirmDetails({
      header: "Current result row",
      rowIds: [],
      columns,
      getRow,
      formatCell: testRowFormatter,
    });

    expect(result).toBe("Current result row");
  });

  it("does not truncate the row list itself, leaving that to DangerConfirmDialog's own bounded preview", () => {
    const manyRows = new Map<number, TestRow>();
    const manyRowIds: number[] = [];
    for (let id = 1; id <= 500; id += 1) {
      manyRows.set(id, [String(id), `Name${id}`]);
      manyRowIds.push(id);
    }
    const getManyRows = (rowId: number) => manyRows.get(rowId);

    const result = buildDeleteRowConfirmDetails({
      header: "Table: people",
      rowIds: manyRowIds,
      columns,
      getRow: getManyRows,
      formatCell: testRowFormatter,
    });

    const lines = result.split("\n");
    expect(lines).toHaveLength(501); // header + 500 rows
    expect(lines).toContain('{"id":"FORMATTED(1)","name":"FORMATTED(Name1)"}');
    expect(lines).toContain('{"id":"FORMATTED(500)","name":"FORMATTED(Name500)"}');
  });

  it("keeps embedded separators and line breaks inside one structured row", () => {
    const result = buildDeleteRowConfirmDetails({
      header: "Table: people",
      rowIds: [1],
      columns: ["id", "name"],
      getRow: () => ["1\nid=999", "Alice, role=admin"],
      formatCell: (row, columnIndex) => row[columnIndex],
    });

    expect(result).toBe('Table: people\n{"id":"1\\nid=999","name":"Alice, role=admin"}');
    expect(result.split("\n")).toHaveLength(2);
  });

  it("keeps the complete formatted value instead of truncating confirmation data", () => {
    const longValue = `${"x".repeat(300)}A`;
    const result = buildDeleteRowConfirmDetails({
      header: "Table: people",
      rowIds: [1],
      columns: ["payload"],
      getRow: () => [longValue],
      formatCell: (row, columnIndex) => row[columnIndex],
    });

    expect(result).toContain(longValue);
    expect(result).not.toContain(`${"x".repeat(256)}...`);
  });

  it("formats every cell through the provided formatCell callback rather than stringifying values itself", () => {
    let calls = 0;
    const result = buildDeleteRowConfirmDetails({
      header: "Table: people",
      rowIds: [1],
      columns,
      getRow,
      formatCell: (row, columnIndex) => {
        calls += 1;
        return `custom:${row[columnIndex]}`;
      },
    });

    expect(calls).toBe(columns.length);
    expect(result).toBe('Table: people\n{"id":"custom:1","name":"custom:Alice"}');
  });
});

describe("data grid detail TSV", () => {
  it("leaves NULL cells empty while preserving literal NULL text", () => {
    const fields = [{ value: null }, { value: "NULL" }] as unknown as DataGridRowDetail["fields"];
    const rowDetail = { fields } as DataGridRowDetail;
    const columnDetail = { fields } as DataGridColumnDetail;

    expect(dataGridRowDetailTsv(rowDetail)).toBe("\tNULL");
    expect(dataGridColumnDetailTsv(columnDetail)).toBe("\nNULL");
  });
});

describe("Mongo collection cell detail presentation", () => {
  it.each([null, "NULL", MONGO_DOCUMENT_GRID_NULL])("presents BSON value %j without leaking grid encoding", (bsonValue) => {
    const value = mongoDocumentGridValue(bsonValue) as string;
    const text = mongoDocumentGridDisplayText(value) ?? displayCellValue(value);
    const detail = buildDataGridCellDetail({
      rowIndex: 0,
      rowId: 0,
      row: [value],
      columns: ["value"],
      columnIndex: 0,
      displayValue: () => text,
      rawValue: () => text,
      isNullValue: (cell) => cell === MONGO_DOCUMENT_GRID_NULL,
      isEditable: true,
    });
    expect(detail).toMatchObject({ value, rawValue: text, rawValuePreview: text, isNull: bsonValue === null, length: bsonValue === null ? 0 : text.length });
    expect(detail!.rawValue).not.toContain("\u0000");
  });

  it("presents the BSON null marker as NULL text in row and column detail fields", () => {
    const value = mongoDocumentGridValue(null) as string;
    const rawValue = (cell: CellValue) => mongoDocumentGridDisplayText(cell) ?? displayCellValue(cell);
    const isNullValue = (cell: CellValue) => cell === MONGO_DOCUMENT_GRID_NULL;
    const rowDetail = buildDataGridRowDetail({
      rowIndex: 0,
      rowId: 1,
      row: [value],
      columns: ["value"],
      columnIndexes: [0],
      displayValue: rawValue,
      rawValue,
      isNullValue,
    });
    const columnDetail = buildDataGridColumnDetail({
      rows: [{ rowIndex: 0, rowId: 1, row: [value] }],
      columns: ["value"],
      columnIndex: 0,
      displayValue: rawValue,
      rawValue,
      isNullValue,
    });

    for (const field of [...rowDetail.fields, ...columnDetail!.fields]) {
      expect(field).toMatchObject({ value, rawValue: "NULL", rawValuePreview: "NULL", isNull: true, length: 0 });
      expect(field.rawValuePreview).not.toContain("\u0000");
    }
  });

  it("restores external BSON null values in row and column detail copy payloads", () => {
    const value = mongoDocumentGridValue(null) as string;
    const rowDetail = buildDataGridRowDetail({
      rowIndex: 0,
      rowId: 1,
      row: [value],
      columns: ["value"],
      columnIndexes: [0],
      displayValue: (cell) => displayCellValue(cell),
    });
    const columnDetail = buildDataGridColumnDetail({
      rows: [{ rowIndex: 0, rowId: 1, row: [value] }],
      columns: ["value"],
      columnIndex: 0,
      displayValue: (cell) => displayCellValue(cell),
    });

    const rowJson = dataGridRowDetailJson(rowDetail, undefined, undefined, mongoDocumentGridExternalValue);
    const columnJson = dataGridColumnDetailJson(columnDetail!, undefined, mongoDocumentGridExternalValue);
    expect(rowJson).toBe('{\n  "value": null\n}');
    expect(columnJson).toBe('[\n  {\n    "row": 1,\n    "value": null\n  }\n]');
    expect(rowJson).not.toContain("\u0000");
    expect(columnJson).not.toContain("\u0000");
    expect(dataGridRowDetailTsv(rowDetail, undefined, mongoDocumentGridExternalValue)).toBe("");
    expect(dataGridColumnDetailTsv(columnDetail!, undefined, mongoDocumentGridExternalValue)).toBe("");
  });
});
