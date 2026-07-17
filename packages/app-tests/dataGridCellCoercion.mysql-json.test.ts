import { strict as assert } from "node:assert";
import { test } from "vitest";
import { coerceDataGridCellValue } from "../../apps/desktop/src/lib/dataGrid/dataGridCellCoercion.ts";

test("MySQL JSON field with English quotes should remain unchanged", () => {
  const input = '{"2:3":"3:4","3:2":"4:3","21:9":"16:9"}';
  const result = coerceDataGridCellValue({
    value: input,
    oldValue: null,
    databaseType: "mysql",
    columnInfo: { data_type: "json" },
  });

  assert.equal(result, input);
  assert.ok(result.includes('"'), "Should contain English quotes");
  assert.ok(!result.includes('“') && !result.includes('”'), "Should NOT contain Chinese quotes");
});

test("MySQL JSON field with Chinese quotes should be normalized to English quotes", () => {
  const input = "{\u201c2:3\u201d:\u201c3:4\u201d,\u201c3:2\u201d:\u201c4:3\u201d,\u201c21:9\u201d:\u201c16:9\u201d}";
  const expected = '{"2:3":"3:4","3:2":"4:3","21:9":"16:9"}';

  const result = coerceDataGridCellValue({
    value: input,
    oldValue: null,
    databaseType: "mysql",
    columnInfo: { data_type: "json" },
  });

  assert.equal(result, expected);
  assert.ok(result.includes('"'), "Should contain English quotes");
  assert.ok(!result.includes('“') && !result.includes('”'), "Should NOT contain Chinese quotes");
});

test("MySQL JSON field with mixed quotes should be normalized", () => {
  const input = "{\u201ckey\u201d:\"value\"}";
  const expected = '{"key":"value"}';

  const result = coerceDataGridCellValue({
    value: input,
    oldValue: null,
    databaseType: "mysql",
    columnInfo: { data_type: "json" },
  });

  assert.equal(result, expected);
});

test("MySQL JSON field with smart apostrophe inside a string should remain unchanged", () => {
  const input = '{"text":"it\u2019s ok"}';
  const result = coerceDataGridCellValue({
    value: input,
    oldValue: null,
    databaseType: "mysql",
    columnInfo: { data_type: "json" },
  });

  assert.equal(result, input);
});
