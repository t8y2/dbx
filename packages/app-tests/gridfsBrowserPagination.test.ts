import assert from "node:assert/strict";
import { test } from "vitest";

import { clampGridFsPage, gridFsTotalPages, paginateGridFsItems } from "../../apps/desktop/src/lib/document/gridfsPagination.ts";

test("paginates GridFS files with a clamped page index", () => {
  const files = ["f1", "f2", "f3", "f4", "f5"].map((id) => ({ id }));

  assert.equal(gridFsTotalPages(files.length, 2), 3);
  assert.equal(clampGridFsPage(9, files.length, 2), 2);
  assert.deepEqual(paginateGridFsItems(files, 1, 2).map((file) => file.id), ["f3", "f4"]);
  assert.deepEqual(paginateGridFsItems(files, 9, 2).map((file) => file.id), ["f5"]);
});
