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
  assert.match(source, /mongo_copy_documents: copyDocuments\.value/);
  assert.match(source, /result\.extended_documents\?\.length === nextDocuments\.length/);
});

test("document edit mode toggles whole JSON editing for insert and save", () => {
  const source = documentBrowserSource();
  assert.match(source, /documentEditMode = ref<"fields" \| "json">\("json"\)/);
  assert.match(source, /setDocumentEditMode\('json'\)/);
  assert.match(source, /setDocumentEditMode\('fields'\)/);
  assert.match(source, /function startEdit\(\)[\s\S]*?documentEditMode\.value = "json"/);
  assert.match(source, /RedisJsonEditor v-model="editJson"/);
  assert.match(source, /documentEditMode\.value = "json"/);
  assert.match(source, /parseDocumentStoreJsonDocument\(editJson\.value, documentStoreProvider\.value\.kind\)/);
  assert.match(source, /emptyDocumentJson\(\)/);
  assert.match(source, /mongo\.jsonReplaceHint/);
  assert.match(source, /isSavingDocument/);
  assert.match(source, /unsupportedJsonNumber|unsupported-number/);
  assert.match(source, /pointer-events-none/);
  assert.match(source, /mongo\.jsonIdRequired/);
  assert.match(source, /applyDocumentStoreIdentityPlan/);
  assert.match(source, /planDocumentStoreIdentityMigration/);
  assert.match(source, /insertDocumentStoreDocumentCore|insertDocumentStoreDocument/);
});

test("document save uses shared identity plan and write helpers", () => {
  const source = documentBrowserSource();
  assert.match(source, /planDocumentStoreIdentityMigration\(/);
  assert.match(source, /applyDocumentStoreIdentityPlan\(/);
  assert.match(source, /resolveDocumentStoreWriteRouting\(/);
  assert.match(source, /isDocumentStoreIdentityField\(/);
  assert.match(source, /normalizeDocumentStoreRouting\(/);
  // No local rekey/replace triple-copy orchestration.
  assert.doesNotMatch(source, /async function rekeyDocumentStoreDocument/);
  assert.doesNotMatch(source, /async function replaceDocumentStoreDocument/);
});

test("document query inputs apply on Enter and reserve Shift+Enter for newlines", () => {
  const source = documentBrowserSource();
  assert.equal(source.match(/@keydown\.enter\.exact\.prevent="applyFilter"/g)?.length, 2);
  assert.doesNotMatch(source, /@keydown\.shift\.enter\.prevent="applyFilter"/);
});
