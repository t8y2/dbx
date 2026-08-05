import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const appSource = readFileSync("apps/desktop/src/App.vue", "utf8");
const sqlFilePanelSource = readFileSync("apps/desktop/src/components/layout/SqlFilePanel.vue", "utf8");

function functionSource(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

test("external SQL saves persist their selected data source before closing", () => {
  const source = functionSource(appSource, "async function saveExternalSqlPath", "function savedSqlTargetForSave");
  const write = source.indexOf("api.writeExternalSqlFile");
  const remember = source.indexOf("rememberExternalSqlFileTarget");
  const close = source.indexOf("queryStore.closeTab");

  assert.ok(write >= 0);
  assert.ok(write < remember);
  assert.ok(remember < close);
});

test("external SQL open entry points restore a saved data source", () => {
  const startupOpen = functionSource(appSource, "async function openSqlFilePath", "async function openPendingSqlFiles");
  const startupResolve = startupOpen.indexOf("resolveExternalSqlFileTarget");
  const startupTabOpen = startupOpen.indexOf("queryStore.openExternalSqlFile");
  assert.ok(startupResolve >= 0);
  assert.ok(startupResolve < startupTabOpen);

  const panelOpen = functionSource(sqlFilePanelSource, "async function openFile", "function executeFile");
  const panelResolve = panelOpen.indexOf("resolveExternalSqlFileTarget");
  const panelTabOpen = panelOpen.indexOf("queryStore.openExternalSqlFile");
  assert.ok(panelResolve >= 0);
  assert.ok(panelResolve < panelTabOpen);

  const pickerOpen = functionSource(appSource, "async function openSqlFile()", "async function importResultArchive");
  assert.ok(pickerOpen.includes("applyExternalSqlFileTarget(tab, sqlPath)"));
});
