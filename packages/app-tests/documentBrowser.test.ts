import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

function searchBarSlotSource(): string {
  const source = readFileSync(path.resolve("apps/desktop/src/components/document/DocumentBrowser.vue"), "utf8");
  const start = source.indexOf('<template #search-bar');
  const end = source.indexOf("\n    </DataGrid>", start);
  assert.notEqual(start, -1, "expected DocumentBrowser search-bar slot");
  assert.notEqual(end, -1, "expected DocumentBrowser DataGrid closing tag");
  return source.slice(start, end);
}

test("mongo document result search bar does not render a duplicate refresh button", () => {
  const slot = searchBarSlotSource();
  assert.equal(slot.includes('{{ t("grid.refresh") }}'), false);
  assert.equal(slot.includes("RefreshCcw"), false);
});
