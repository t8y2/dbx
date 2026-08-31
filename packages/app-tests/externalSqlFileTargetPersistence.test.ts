import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const appSource = readFileSync("apps/desktop/src/App.vue", "utf8");
const sqlFilePanelSource = readFileSync("apps/desktop/src/components/layout/SqlFilePanel.vue", "utf8");
const externalSqlFileChangesSource = readFileSync("apps/desktop/src/composables/useExternalSqlFileChanges.ts", "utf8");

function functionSource(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

test("external SQL saves persist their selected data source before closing", () => {
  const source = functionSource(appSource, "async function writeExternalSqlTab", "async function saveExternalSqlPath");
  const write = source.indexOf("api.writeExternalSqlFile");
  const remember = source.indexOf("rememberExternalSqlFileTarget");
  const close = source.indexOf("queryStore.closeTab");

  assert.ok(write >= 0);
  assert.ok(write < remember);
  assert.ok(remember < close);
  assert.ok(source.includes("catalog: tab.catalog"));
});

test("external SQL open entry points restore a saved data source", () => {
  const startupOpen = functionSource(appSource, "async function openSqlFilePath", "async function openPendingSqlFiles");
  const startupResolve = startupOpen.indexOf("resolveExternalSqlFileTarget");
  const startupTabOpen = startupOpen.indexOf("queryStore.openExternalSqlFile");
  assert.ok(startupResolve >= 0);
  assert.ok(startupResolve < startupTabOpen);
  assert.ok(startupOpen.includes("snapshot.version, target.catalog"));

  const panelOpen = functionSource(sqlFilePanelSource, "async function openFile", "function executeFile");
  const panelResolve = panelOpen.indexOf("resolveExternalSqlFileTarget");
  const panelTabOpen = panelOpen.indexOf("queryStore.openExternalSqlFile");
  assert.ok(panelResolve >= 0);
  assert.ok(panelResolve < panelTabOpen);
  assert.ok(panelOpen.includes("snapshot.version, target.catalog"));

  const pickerOpen = functionSource(appSource, "async function openSqlFile()", "async function importResultArchive");
  assert.ok(pickerOpen.includes("applyExternalSqlFileTarget(tab, sqlPath)"));
});

test("external SQL catalog changes persist their complete target", () => {
  const source = functionSource(appSource, "function changeActiveCatalog", "async function setActiveDatabaseAsDefault");
  assert.ok(source.includes("queryStore.updateCatalog(tab.id, catalog, database)"));
  assert.ok(source.includes("rememberExternalSqlFileTarget"));
  assert.ok(source.includes("{ connectionId: tab.connectionId, database, catalog }"));
});

test("external SQL overwrite and recreate actions keep checked-write preconditions", () => {
  const prepareSave = functionSource(externalSqlFileChangesSource, "async function prepareSave", "\n  watch(");
  assert.ok(prepareSave.includes("expectedContentHash: change.snapshot.version.contentHash"));
  assert.ok(prepareSave.includes("expectedMissing: true"));
  assert.equal(prepareSave.includes("force: true"), false);

  const setup = appSource.slice(appSource.indexOf("const externalSqlFileChanges = useExternalSqlFileChanges"), appSource.indexOf("const externalSqlFilePrompt"));
  assert.ok(setup.includes("writeExternalSqlTab(tab, { expectedMissing: true })"));
});
