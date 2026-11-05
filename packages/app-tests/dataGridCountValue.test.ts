import { strict as assert } from "node:assert";
import { test } from "vitest";
import { sumGridCountValues } from "../../apps/desktop/src/lib/dataGrid/dataGridCountValue.ts";

test("sums the per-field counts of an influxql aggregate row", () => {
  // InfluxQL prefixes aggregate rows with the bucket time and returns one
  // count per field; the total is the sum of the count columns.
  assert.equal(sumGridCountValues(["1970-01-01T00:00:00Z", 65052, 62484, 2568]), 130104);
});

test("reads plain count rows unchanged", () => {
  assert.equal(sumGridCountValues([42]), 42);
  assert.equal(sumGridCountValues(["42"]), 42);
});

test("returns undefined for rows without a count", () => {
  assert.equal(sumGridCountValues(undefined), undefined);
  assert.equal(sumGridCountValues([]), undefined);
  assert.equal(sumGridCountValues([null, ""]), undefined);
});
