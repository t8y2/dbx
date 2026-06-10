import { strict as assert } from "node:assert";
import { test } from "vitest";
import { formatTemporalInputValue, parseTemporalInputValue, temporalCellEditorKind } from "../../apps/desktop/src/lib/dataGridTemporalEditor.ts";

test("detects explicit date time column types for grid editing", () => {
  assert.equal(temporalCellEditorKind("date"), "date");
  assert.equal(temporalCellEditorKind("Date32"), "date");
  assert.equal(temporalCellEditorKind("time without time zone"), "time");
  assert.equal(temporalCellEditorKind("timestamp with time zone"), "datetime");
  assert.equal(temporalCellEditorKind("datetime2(3)"), "datetime");
  assert.equal(temporalCellEditorKind("Nullable(DateTime64(3))"), "datetime");
  assert.equal(temporalCellEditorKind("varchar"), undefined);
  assert.equal(temporalCellEditorKind("updated_at"), undefined);
});

test("formats existing temporal cell values for native inputs", () => {
  assert.equal(formatTemporalInputValue("2026-05-19 08:30:45", "date"), "2026-05-19");
  assert.equal(formatTemporalInputValue("2026-05-19 08:30:45", "datetime"), "2026-05-19T08:30:45");
  assert.equal(formatTemporalInputValue("08:30:45.123456", "time"), "08:30:45");
  assert.equal(formatTemporalInputValue(null, "datetime"), "");
});

test("parses native temporal input values back to grid save strings", () => {
  assert.equal(parseTemporalInputValue("2026-05-19", "date"), "2026-05-19");
  assert.equal(parseTemporalInputValue("2026-05-19T08:30", "datetime"), "2026-05-19 08:30:00");
  assert.equal(parseTemporalInputValue("2026-05-19T08:30:45", "datetime"), "2026-05-19 08:30:45");
  assert.equal(parseTemporalInputValue("08:30", "time"), "08:30:00");
  assert.equal(parseTemporalInputValue("", "time"), null);
});
