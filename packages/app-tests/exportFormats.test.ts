import { strict as assert } from "node:assert";
import { test } from "vitest";
import { formatCsv } from "../../apps/desktop/src/lib/export/exportFormats.ts";

test("formatCsv writes database null as an empty cell and preserves literal NULL", () => {
  assert.equal(
    formatCsv(
      ["id", "note"],
      [
        [1, null],
        [2, ""],
        [3, "NULL"],
      ],
    ),
    '"id","note"\n"1",\n"2",""\n"3","NULL"',
  );
});

test("formatCsv only quotes fields with CSV special characters in necessary mode", () => {
  assert.equal(
    formatCsv(
      ["id", "district,name", "note"],
      [
        [2085252644, "延庆县", "plain"],
        [2085252645, "门头沟区", 'line 1\n"line 2"'],
      ],
      "necessary",
    ),
    'id,"district,name",note\n2085252644,延庆县,plain\n2085252645,门头沟区,"line 1\n""line 2"""',
  );
});
