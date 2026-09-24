import assert from "node:assert/strict";
import { test } from "vitest";
import { tableColumnDefaultDisplayValue } from "@/lib/table/tableColumnDefaultPresentation";

test("table column defaults preserve raw database expressions", () => {
  const values = [null, "''", "0", "CURRENT_TIMESTAMP", "((1))", "('prefix (internal)')", "x".repeat(512)] as const;

  assert.deepEqual(values.map(tableColumnDefaultDisplayValue), ["—", ...values.slice(1)]);
  assert.equal(tableColumnDefaultDisplayValue(undefined), "—");
  assert.equal(tableColumnDefaultDisplayValue(""), "");
});
