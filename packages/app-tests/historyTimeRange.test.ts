import { strict as assert } from "node:assert";
import { test } from "vitest";
import { historyDateRangeIsValid, historyEntryMatchesDateRange } from "../../apps/desktop/src/lib/history/historyTimeRange.ts";

test("matches entries on the selected start and end dates inclusively", () => {
  const range = { startDate: "2026-06-01", endDate: "2026-06-18" };

  assert.equal(historyEntryMatchesDateRange("2026-06-01T00:00:00.000", range), true);
  assert.equal(historyEntryMatchesDateRange("2026-06-18T23:59:59.999", range), true);
  assert.equal(historyEntryMatchesDateRange("2026-05-31T23:59:59.999", range), false);
  assert.equal(historyEntryMatchesDateRange("2026-06-19T00:00:00.000", range), false);
});

test("supports open-ended date ranges", () => {
  assert.equal(historyEntryMatchesDateRange("2026-06-18T12:00:00.000", { startDate: "2026-06-18", endDate: "" }), true);
  assert.equal(historyEntryMatchesDateRange("2026-06-17T23:59:59.999", { startDate: "2026-06-18", endDate: "" }), false);
  assert.equal(historyEntryMatchesDateRange("2026-06-18T23:59:59.999", { startDate: "", endDate: "2026-06-18" }), true);
  assert.equal(historyEntryMatchesDateRange("2026-06-19T00:00:00.000", { startDate: "", endDate: "2026-06-18" }), false);
});

test("validates date range ordering", () => {
  assert.equal(historyDateRangeIsValid({ startDate: "2026-06-01", endDate: "2026-06-18" }), true);
  assert.equal(historyDateRangeIsValid({ startDate: "2026-06-18", endDate: "2026-06-01" }), false);
  assert.equal(historyDateRangeIsValid({ startDate: "2026-06-18", endDate: "" }), true);
});
