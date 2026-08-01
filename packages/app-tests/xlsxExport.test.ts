import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildXlsxWorkbook, buildXlsxWorkbookMulti, buildXlsxWorkbookMultiWithMaxRows } from "../../apps/desktop/src/lib/export/xlsxExport.ts";
import { buildXlsxSqlWorksheet } from "../../apps/desktop/src/lib/export/xlsxSqlSheet.ts";

function readStoredZipEntry(workbook: Uint8Array, entryPath: string): string {
  const view = new DataView(workbook.buffer, workbook.byteOffset, workbook.byteLength);
  let offset = 0;
  while (offset + 30 <= workbook.length && view.getUint32(offset, true) === 0x04034b50) {
    const compressedSize = view.getUint32(offset + 18, true);
    const fileNameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const fileNameStart = offset + 30;
    const dataStart = fileNameStart + fileNameLength + extraLength;
    const fileName = new TextDecoder().decode(workbook.subarray(fileNameStart, fileNameStart + fileNameLength));
    if (fileName === entryPath) return new TextDecoder().decode(workbook.subarray(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  throw new Error(`Missing ZIP entry: ${entryPath}`);
}

test("builds an xlsx workbook zip with worksheet data", () => {
  const workbook = buildXlsxWorkbook({
    sheetName: "Users",
    columns: ["id", "name", "active"],
    rows: [
      [1, "Ada & Bob", true],
      [2, null, false],
    ],
  });
  const text = new TextDecoder().decode(workbook);

  assert.equal(workbook[0], 0x50);
  assert.equal(workbook[1], 0x4b);
  assert.match(text, /\[Content_Types\]\.xml/);
  assert.match(text, /xl\/worksheets\/sheet1\.xml/);
  assert.match(text, /name="Users"/);
  assert.match(text, /<c r="A2"><v>1<\/v><\/c>/);
  assert.match(text, /Ada &amp; Bob/);
  assert.match(text, /<c r="C2" t="b"><v>1<\/v><\/c>/);
});

test("sanitizes invalid sheet names", () => {
  const workbook = buildXlsxWorkbook({
    sheetName: "bad/name:with*chars?and-a-very-long-tail",
    columns: ["value"],
    rows: [["ok"]],
  });
  const text = new TextDecoder().decode(workbook);

  assert.match(text, /name="bad name with chars and-a-very-"/);
});

test("writes MySQL 5.7 numeric strings as numeric cells", () => {
  const workbook = buildXlsxWorkbook({
    sheetName: "MySQL 5.7",
    columns: ["nullable_int", "float_value", "double_value", "decimal_value", "bigint_high_precision"],
    columnTypes: ["int(11)", "float", "double", "decimal(18,6)", "bigint(20)"],
    rows: [["42", "123.5", "987654.321", "2800.000000", "9007199254740992"]],
    numericColumnRightAlign: false,
  });
  const text = new TextDecoder().decode(workbook);

  assert.match(text, /<c r="A2" s="3"><v>42<\/v><\/c>/);
  assert.match(text, /<c r="B2" s="3"><v>123\.5<\/v><\/c>/);
  assert.match(text, /<c r="C2" s="3"><v>987654\.321<\/v><\/c>/);
  assert.match(text, /<c r="D2" s="3"><v>2800\.000000<\/v><\/c>/);
  assert.match(text, /<c r="E2" t="inlineStr" s="3"><is><t>9007199254740992<\/t><\/is><\/c>/);
});

test("builds a result workbook with a separate SQL worksheet", () => {
  const sqlWorksheet = buildXlsxSqlWorksheet([{ sql: "SELECT id, name FROM users WHERE active = true" }]);
  assert.ok(sqlWorksheet);
  const workbook = buildXlsxWorkbookMulti([{ sheetName: "Result", columns: ["id", "name"], rows: [[1, "Ada"]] }, sqlWorksheet]);
  const text = new TextDecoder().decode(workbook);

  assert.match(text, /name="Result"/);
  assert.match(text, /name="SQL"/);
  assert.match(text, /xl\/worksheets\/sheet2\.xml/);
  assert.match(text, /SELECT id, name FROM users WHERE active = true/);
});

test("web in-memory XLSX export splits oversized worksheets", () => {
  const workbook = buildXlsxWorkbookMultiWithMaxRows(
    [
      {
        sheetName: "Result",
        columns: ["id", "name"],
        rows: [
          [1, "row_1"],
          [2, "row_2"],
          [3, "row_3"],
          [4, "row_4"],
          [5, "row_5"],
        ],
      },
    ],
    2,
  );

  const workbookXml = readStoredZipEntry(workbook, "xl/workbook.xml");
  assert.match(workbookXml, /name="Result"/);
  assert.match(workbookXml, /name="Result \(2\)"/);
  assert.match(workbookXml, /name="Result \(3\)"/);

  const sheet1 = readStoredZipEntry(workbook, "xl/worksheets/sheet1.xml");
  const sheet2 = readStoredZipEntry(workbook, "xl/worksheets/sheet2.xml");
  const sheet3 = readStoredZipEntry(workbook, "xl/worksheets/sheet3.xml");
  assert.match(sheet1, /row_1/);
  assert.match(sheet1, /row_2/);
  assert.doesNotMatch(sheet1, /row_3/);
  assert.match(sheet2, /row_3/);
  assert.match(sheet2, /row_4/);
  assert.doesNotMatch(sheet2, /row_5/);
  assert.match(sheet3, /row_5/);
  assert.equal(sheet1.match(/<row r="/g)?.length, 3);
  assert.equal(sheet2.match(/<row r="/g)?.length, 3);
  assert.equal(sheet3.match(/<row r="/g)?.length, 2);
});

test("web in-memory XLSX export handles a realistic large result", () => {
  const rowCount = 20_001;
  const rows = Array.from({ length: rowCount }, (_, index) => [index + 1, `user_${index + 1}`, `user_${index + 1}@example.com`, index % 2 === 0, `note-${String(index + 1).padStart(6, "0")}-${"x".repeat(48)}`]);
  const workbook = buildXlsxWorkbookMultiWithMaxRows([{ sheetName: "Users", columns: ["id", "name", "email", "active", "notes"], rows }], 10_000);

  const workbookXml = readStoredZipEntry(workbook, "xl/workbook.xml");
  assert.equal(workbookXml.match(/<sheet /g)?.length, 3);
  assert.match(workbookXml, /name="Users \(3\)"/);
  assert.match(readStoredZipEntry(workbook, "xl/worksheets/sheet1.xml"), /user_10000@example\.com/);
  assert.match(readStoredZipEntry(workbook, "xl/worksheets/sheet2.xml"), /user_20000@example\.com/);
  const finalSheet = readStoredZipEntry(workbook, "xl/worksheets/sheet3.xml");
  assert.match(finalSheet, /user_20001@example\.com/);
  assert.equal(finalSheet.match(/<row r="/g)?.length, 2);
  assert.ok(workbook.byteLength > 5_000_000);
});

test("maps multiple result statements and splits SQL at the Excel cell limit", () => {
  const bmpPrefix = "x".repeat(32_766);
  const longSql = `${bmpPrefix}😀tail`;
  const worksheet = buildXlsxSqlWorksheet([
    { resultName: "Result 1", sql: "SELECT 1" },
    { resultName: "Result 2", sql: longSql },
  ]);

  assert.ok(worksheet);
  assert.deepEqual(worksheet.columns, ["Result", "SQL"]);
  assert.equal(worksheet.rows.length, 3);
  assert.deepEqual(worksheet.rows[0], ["Result 1", "SELECT 1"]);
  const longSqlRows = worksheet.rows.slice(1);
  assert.ok(longSqlRows.every((row) => String(row[1]).length <= 32_767));
  assert.equal(longSqlRows[0][1], bmpPrefix);
  assert.equal(longSqlRows[1][1], "😀tail");
  assert.equal(longSqlRows.map((row) => row[1]).join(""), longSql);
});

test("numericColumnRightAlign: true applies right-align style to numeric columns", () => {
  const workbook = buildXlsxWorkbook({
    sheetName: "Aligned",
    columns: ["amount", "label"],
    columnTypes: ["decimal(10,2)", "varchar(50)"],
    rows: [[1.5, "row"]],
    numericColumnRightAlign: true,
  });
  const text = new TextDecoder().decode(workbook);
  // Numeric column A should have right-align style (s="2")
  assert.match(text, /<c r="A2" s="2"><v>1\.5<\/v><\/c>/);
  // Text column B should NOT have right-align style
  assert.doesNotMatch(text, /<c r="B2"[^>]* s="2"/);
});

test("numericColumnRightAlign: false applies left-align style to numeric columns", () => {
  const workbook = buildXlsxWorkbook({
    sheetName: "Disabled",
    columns: ["amount", "label"],
    columnTypes: ["decimal(10,2)", "varchar(50)"],
    rows: [[1.5, "row"]],
    numericColumnRightAlign: false,
  });
  const text = new TextDecoder().decode(workbook);
  // Numeric column should have left-align style (s="3"), not right-align (s="2")
  assert.match(text, /<c r="A2" s="3"><v>1\.5<\/v><\/c>/);
  assert.doesNotMatch(text, /<c r="A2"[^>]* s="2"/);
});

test("numericColumnRightAlign defaults to true when omitted", () => {
  // Backwards compatibility: existing callers that do not pass the flag must
  // keep producing right-aligned numeric cells.
  const workbook = buildXlsxWorkbook({
    sheetName: "Default",
    columns: ["amount", "label"],
    columnTypes: ["decimal(10,2)", "varchar(50)"],
    rows: [[1.5, "row"]],
  });
  const text = new TextDecoder().decode(workbook);
  assert.match(text, /<c r="A2" s="2"><v>1\.5<\/v><\/c>/);
  assert.doesNotMatch(text, /<c r="B2"[^>]* s="2"/);
});

test("numeric right-align style is applied consistently across cross-database numeric types", () => {
  // Ensures the front-end XLSX classifier covers the same cross-database
  // numeric types as the Rust classifier and the grid (ClickHouse wide
  // integers, Oracle/Dameng binary floats, SQL Server internal names, etc.).
  const columnTypes = ["Int16", "Int32", "Int64", "Int128", "UInt256", "Decimal128(18, 2)", "Float16", "BINARY_FLOAT", "BINARY_DOUBLE", "decimaln", "numericn", "intn", "floatn", "moneyn", "smallmoneyn", "varchar(50)"];
  const workbook = buildXlsxWorkbook({
    sheetName: "CrossDb",
    columns: columnTypes.map((t) => t.toLowerCase()),
    columnTypes,
    rows: [columnTypes.map(() => 1)],
    numericColumnRightAlign: true,
  });
  const text = new TextDecoder().decode(workbook);
  const letters = "ABCDEFGHIJKLMNOP";
  columnTypes.slice(0, -1).forEach((_, index) => {
    const ref = `${letters[index]}2`;
    assert.match(text, new RegExp(`<c r="${ref}" s="2"><v>1</v></c>`), `expected right-align style for ${columnTypes[index]}`);
  });
  // Text column (last) must not receive the numeric right-align style.
  assert.doesNotMatch(text, /<c r="P2"[^>]* s="2"/);
});

test("numeric right-align disabled applies left-align style across cross-database numeric types", () => {
  const columnTypes = ["Int16", "Int64", "Int128", "Decimal128(18, 2)", "BINARY_FLOAT", "decimaln", "varchar(50)"];
  const workbook = buildXlsxWorkbook({
    sheetName: "CrossDbDisabled",
    columns: columnTypes.map((t) => t.toLowerCase()),
    columnTypes,
    rows: [columnTypes.map(() => 1)],
    numericColumnRightAlign: false,
  });
  const text = new TextDecoder().decode(workbook);
  // All numeric columns must use left-align (s="3") to override Excel's
  // default right alignment for number cells.
  const letters = "ABCDEFG";
  columnTypes.slice(0, -1).forEach((_, index) => {
    const ref = `${letters[index]}2`;
    assert.match(text, new RegExp(`<c r="${ref}" s="3"><v>1</v></c>`), `expected left-align style for ${columnTypes[index]}`);
  });
  assert.doesNotMatch(text, /s="2"/);
});
