import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

function searchBarSlotSource(): string {
  const source = readFileSync(path.resolve("apps/desktop/src/components/document/DocumentBrowser.vue"), "utf8");
  const start = source.indexOf("<template #search-bar");
  const end = source.indexOf("\n    </DataGrid>", start);
  assert.notEqual(start, -1, "expected DocumentBrowser search-bar slot");
  assert.notEqual(end, -1, "expected DocumentBrowser DataGrid closing tag");
  return source.slice(start, end);
}

function documentBrowserSource(): string {
  return readFileSync(path.resolve("apps/desktop/src/components/document/DocumentBrowser.vue"), "utf8");
}

test("mongo document result search bar does not render a duplicate refresh button", () => {
  const slot = searchBarSlotSource();
  assert.equal(slot.includes('{{ t("grid.refresh") }}'), false);
  assert.equal(slot.includes("RefreshCcw"), false);
});

test("mongo document table passes copy context to the data grid", () => {
  const source = documentBrowserSource();
  assert.match(source, /<DataGrid[\s\S]*?:database-type="props\.databaseType"[\s\S]*?<\/DataGrid>/);
  assert.match(source, /const customSaveHandler = computed<CustomSaveHandler>\(\(\) => \(\{[\s\S]*?targetLabel: props\.collection,[\s\S]*?\}\)\);/);
});
