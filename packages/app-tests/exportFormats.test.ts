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
