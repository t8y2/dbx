import { strict as assert } from "node:assert";
import test from "node:test";
import { matchesRowStatusFilter, rowStatusFilterAfterAddingRow, type RowStatus } from "../src/lib/gridRowStatus.ts";

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
