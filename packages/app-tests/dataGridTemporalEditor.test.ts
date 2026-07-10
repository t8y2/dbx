import { strict as assert } from "node:assert";
import { test } from "vitest";
import { parseTemporalInputValue, stepTemporalInputValue } from "../../apps/desktop/src/lib/dataGrid/dataGridTemporalEditor.ts";

test("steps datetime date and time parts", () => {
  assert.equal(stepTemporalInputValue("2025-07-01 13:41:49", "datetime", "day", 1), "2025-07-02 13:41:49");
  assert.equal(stepTemporalInputValue("2025-07-01 13:41:49", "datetime", "month", 1), "2025-08-01 13:41:49");
  assert.equal(stepTemporalInputValue("2025-07-01 13:41:49", "datetime", "hour", 1), "2025-07-01 14:41:49");
  assert.equal(stepTemporalInputValue("2025-07-01 13:41:49", "datetime", "minute", -1), "2025-07-01 13:40:49");
  assert.equal(stepTemporalInputValue("2025-07-01 13:41:49", "datetime", "second", 1), "2025-07-01 13:41:50");
});

test("clamps stepped dates to the target month", () => {
  assert.equal(stepTemporalInputValue("2025-01-31", "date", "month", 1), "2025-02-28");
  assert.equal(stepTemporalInputValue("2024-01-31", "date", "month", 1), "2024-02-29");
});

test("wraps stepped time values", () => {
  assert.equal(stepTemporalInputValue("23:59:59", "time", "hour", 1), "00:59:59");
  assert.equal(stepTemporalInputValue("23:59:59", "time", "minute", 1), "23:00:59");
  assert.equal(stepTemporalInputValue("23:59:59", "time", "second", 1), "23:59:00");
});

test("parses directly typed datetime values for MySQL-compatible editing", () => {
  assert.equal(parseTemporalInputValue("2026-07-08 12:34:56", "datetime"), "2026-07-08 12:34:56");
  assert.equal(parseTemporalInputValue("2026-07-08T12:34", "datetime"), "2026-07-08 12:34:00");
  assert.equal(parseTemporalInputValue("not-a-date", "datetime"), "not-a-date");
  assert.equal(parseTemporalInputValue("not-a-dateT12:34", "datetime"), "not-a-dateT12:34");
});
