import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import { clampGridFsPage, gridFsTotalPages, paginateGridFsItems } from "../../apps/desktop/src/lib/document/gridfsPagination.ts";

test("paginates GridFS files with a clamped page index", () => {
  const files = ["f1", "f2", "f3", "f4", "f5"].map((id) => ({ id }));

  assert.equal(gridFsTotalPages(files.length, 2), 3);
  assert.equal(clampGridFsPage(9, files.length, 2), 2);
  assert.deepEqual(paginateGridFsItems(files, 1, 2).map((file) => file.id), ["f3", "f4"]);
  assert.deepEqual(paginateGridFsItems(files, 9, 2).map((file) => file.id), ["f5"]);
});

test("GridFS browsers keep a scrollable flex layout", () => {
  const bucketBrowser = readFileSync("apps/desktop/src/components/document/MongoBucketBrowser.vue", "utf8");
  const gridfsBrowser = readFileSync("apps/desktop/src/components/document/MongoGridFsBrowser.vue", "utf8");

  assert.match(bucketBrowser, /class="flex h-full min-h-0 flex-col overflow-hidden"/);
  assert.match(bucketBrowser, /v-else class="min-h-0 flex flex-1 flex-col overflow-hidden xl:flex-row/);
  assert.match(gridfsBrowser, /class="flex h-full min-h-0 flex-col overflow-hidden"/);
  assert.match(gridfsBrowser, /v-else class="min-h-0 flex flex-1 flex-col overflow-hidden xl:flex-row/);
});

test("GridFS file browser keeps metadata columns compact on a single line", () => {
  const bucketBrowser = readFileSync("apps/desktop/src/components/document/MongoBucketBrowser.vue", "utf8");

  assert.match(bucketBrowser, /<table class="min-w-full border-collapse text-\[13px\]">/);
  assert.match(bucketBrowser, /whitespace-nowrap tabular-nums/);
});
