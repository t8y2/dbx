import { strict as assert } from "node:assert";
import { test } from "vitest";
import { canApplyGridSelectionValue, matchesRowStatusFilter, rowStatusFilterAfterAddingRow, type RowStatus } from "../../apps/desktop/src/lib/gridRowStatus.ts";

const statuses: RowStatus[] = ["clean", "edited", "new", "deleted"];

test("status filter includes every row in all mode", () => {
  assert.deepEqual(
    statuses.filter((status) => matchesRowStatusFilter(status, "all")),
    ["clean", "edited", "new", "deleted"],
  );
});

test("status filter includes only changed rows in changed mode", () => {
  assert.deepEqual(
    statuses.filter((status) => matchesRowStatusFilter(status, "changed")),
    ["edited", "new", "deleted"],
  );
});

test("status filter can isolate a single changed status", () => {
  assert.deepEqual(
    statuses.filter((status) => matchesRowStatusFilter(status, "edited")),
    ["edited"],
  );
  assert.deepEqual(
    statuses.filter((status) => matchesRowStatusFilter(status, "deleted")),
    ["deleted"],
  );
});

test("adding a row switches filters that would hide new rows back to all", () => {
  assert.equal(rowStatusFilterAfterAddingRow("deleted"), "all");
  assert.equal(rowStatusFilterAfterAddingRow("edited"), "all");
  assert.equal(rowStatusFilterAfterAddingRow("changed"), "changed");
  assert.equal(rowStatusFilterAfterAddingRow("new"), "new");
});

test("selection value fill skips quick entry draft rows", () => {
  assert.equal(canApplyGridSelectionValue({ isDraft: false }), true);
  assert.equal(canApplyGridSelectionValue({ isDraft: true }), false);
  assert.equal(canApplyGridSelectionValue({ isDraft: true, allowDraft: true }), true);
});
