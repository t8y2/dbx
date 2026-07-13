import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildXlsxWorkbook } from "../../apps/desktop/src/lib/export/xlsxExport.ts";

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
