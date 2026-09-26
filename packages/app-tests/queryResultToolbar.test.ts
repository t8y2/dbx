import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const contentAreaPath = "apps/desktop/src/components/layout/ContentArea.vue";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

test("ContentArea keeps query-result insert and delete capabilities separate", () => {
  const contentArea = source(contentAreaPath);

  assert.match(contentArea, /:allow-insert-rows="activeTab\.queryAnalysis\?\.allowInsert \?\? activeTab\.queryAnalysis\?\.allowInsertDelete !== false"/);
  assert.match(contentArea, /:allow-delete-rows="activeTab\.queryAnalysis\?\.allowDelete \?\? activeTab\.queryAnalysis\?\.allowInsertDelete !== false"/);
});
