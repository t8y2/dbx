import { strict as assert } from "node:assert";
import { test } from "vitest";
import { formatCsv } from "../../apps/desktop/src/lib/export/exportFormats.ts";

// NULL 必须写成独立字面量、空字符串才写成空字段，否则导出再导入时 '' 会被还原成
// NULL，写回 NOT NULL DEFAULT '' 的列就会报「不允许为 null」。
test("formatCsv writes database null as the shared NULL literal and keeps empty strings empty", () => {
  assert.equal(
    formatCsv(
      ["id", "note"],
      [
        [1, null],
        [2, ""],
        [3, "NULL"],
      ],
    ),
    '"id","note"\n"1","\\N"\n"2",""\n"3","NULL"',
  );
});

test("formatCsv keeps the legacy empty-cell NULL when the literal is explicitly disabled", () => {
  assert.equal(
    formatCsv(
      ["id", "note"],
      [
        [1, null],
        [2, ""],
      ],
      "all",
      "",
    ),
    '"id","note"\n"1",\n"2",""',
  );
});

test("formatCsv only quotes fields with CSV special characters in necessary mode", () => {
  assert.equal(
    formatCsv(
      ["id", "district,name", "note"],
      [
        [2085252644, "延庆县", "plain"],
        [2085252645, "门头沟区", 'line 1\n"line 2"'],
        [2085252646, "昌平区", null],
      ],
      "necessary",
    ),
    'id,"district,name",note\n2085252644,延庆县,plain\n2085252645,门头沟区,"line 1\n""line 2"""\n2085252646,昌平区,\\N',
  );
});
