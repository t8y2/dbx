import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildXlsxWorkbook, buildXlsxWorkbookMulti } from "../../apps/desktop/src/lib/export/xlsxExport.ts";
import { buildXlsxSqlWorksheet } from "../../apps/desktop/src/lib/export/xlsxSqlSheet.ts";

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
  });
  const text = new TextDecoder().decode(workbook);

  assert.match(text, /<c r="A2"><v>42<\/v><\/c>/);
  assert.match(text, /<c r="B2"><v>123\.5<\/v><\/c>/);
  assert.match(text, /<c r="C2"><v>987654\.321<\/v><\/c>/);
  assert.match(text, /<c r="D2"><v>2800\.000000<\/v><\/c>/);
  assert.match(text, /<c r="E2" t="inlineStr"><is><t>9007199254740992<\/t><\/is><\/c>/);
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
