import { strict as assert } from "node:assert";
import { test } from "vitest";
import { formatCsv } from "../../apps/desktop/src/lib/export/exportFormats.ts";

test("formatCsv preserves query result null display text", () => {
  assert.equal(formatCsv(["id", "note"], [[1, null]]), "\"id\",\"note\"\n\"1\",\"NULL\"");
});
