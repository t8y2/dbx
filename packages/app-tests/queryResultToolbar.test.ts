import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc";

const contentAreaPath = "apps/desktop/src/components/layout/ContentArea.vue";
const appPath = "apps/desktop/src/App.vue";
const dataGridPath = "apps/desktop/src/components/grid/DataGrid.vue";
const viewSwitcherPath = "apps/desktop/src/components/layout/QueryResultViewSwitcher.vue";
const toolbarActionsPath = "apps/desktop/src/components/layout/QueryResultToolbarActions.vue";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function assertSfcCompiles(path: string): void {
  const { descriptor, errors } = parse(source(path), { filename: path });
  assert.deepEqual(errors, [], `${path} should parse without SFC errors`);
  assert.ok(descriptor.scriptSetup, `${path} should have a script setup block`);
  compileScript(descriptor, { id: path });
  if (descriptor.template) {
    const result = compileTemplate({ id: path, filename: path, source: descriptor.template.content });
    assert.deepEqual(result.errors, [], `${path} template should compile`);
  }
}

test("query result toolbar SFCs compile", () => {
  for (const path of [contentAreaPath, dataGridPath, viewSwitcherPath, toolbarActionsPath]) assertSfcCompiles(path);
});

test("ContentArea keeps DISTINCT inserts separate from result-row deletes", () => {
  const contentArea = source(contentAreaPath);

  assert.match(contentArea, /:allow-insert-rows="activeTab\.queryAnalysis\?\.allowInsert \?\? activeTab\.queryAnalysis\?\.allowInsertDelete !== false"/);
  assert.match(contentArea, /:allow-delete-rows="activeTab\.queryAnalysis\?\.allowInsertDelete !== false"/);
});

test("query result toolbar reuses the production icon contract", () => {
  const contentArea = source(contentAreaPath);
  const viewSwitcher = source(viewSwitcherPath);
  const toolbarActions = source(toolbarActionsPath);

  assert.match(contentArea, /<Pin class="h-3\.5 w-3\.5"/);
  assert.match(contentArea, /<Wrench class="h-4 w-4"/);
  assert.match(contentArea, /<ChevronDown class="h-3\.5 w-3\.5"/);
  assert.match(viewSwitcher, /import \{ BarChart3, ListChecks, MessageSquareText \} from "@lucide\/vue"/);
  assert.match(toolbarActions, /import \{ GitBranch, Loader2, Upload \} from "@lucide\/vue"/);
  assert.match(viewSwitcher, /inline-flex h-4 items-center leading-none/);
  assert.match(toolbarActions, /block h-3\.5 w-3\.5 self-center/);
  assert.doesNotMatch(viewSwitcher + toolbarActions, /<svg\b|<symbol\b|<use\b/);
});

test("ContentArea exposes retained result runs as switchable tabs or a compact list", () => {
  const contentArea = source(contentAreaPath);
  const runScrollerStart = contentArea.indexOf('ref="resultTabsScrollerRef"');
  const listSelectorStart = contentArea.indexOf('<div v-else-if="showResultRunSelector"', runScrollerStart);
  const fixedResultSetStart = contentArea.indexOf("data-result-set-tabs-region", listSelectorStart);

  assert.match(contentArea, /showResultRunTabs = computed\(\(\) => resultRuns\.value\.length > 0 && resultRunDisplayMode\.value === "tabs"\)/);
  assert.match(contentArea, /showResultRunSelector = computed\(\(\) => resultRuns\.value\.length > 0 && resultRunDisplayMode\.value === "list"\)/);
  assert.match(contentArea, /ref="resultTabsScrollerRef"[\s\S]*v-for="\(run, runIndex\) in resultRuns"/);
  assert.match(contentArea, /role="tablist" :aria-label="t\('tabs\.resultRuns'\)"/);
  assert.match(contentArea, /data-result-run-tab/);
  assert.match(contentArea, /@keydown="onResultRunTabKeydown\(\$event, runIndex\)"/);
  assert.match(contentArea, /@click\.stop\.prevent="removeResultRun\(run\.id\)"/);
  assert.match(contentArea, /const canCloseQueryResult = computed\([\s\S]*!props\.activeTab\.activeResultRunId/);
  assert.match(contentArea, /v-if="canCloseQueryResult"[\s\S]*@click="closeCurrentQueryResult"/);
  assert.match(contentArea, /queryStore\.closeQueryResult\(props\.activeTab\.id\)/);
  assert.match(contentArea, /t\('tabs\.closeResult'\)/);
  assert.match(contentArea, /<DropdownMenuContent align="start" class="w-48">[\s\S]*v-for="run in resultRuns"/);
  assert.match(contentArea, /setResultRunDisplayMode\('list'\)/);
  assert.match(contentArea, /setResultRunDisplayMode\('tabs'\)/);
  assert.ok(runScrollerStart >= 0);
  assert.ok(listSelectorStart > runScrollerStart);
  assert.ok(fixedResultSetStart > listSelectorStart);
  assert.doesNotMatch(contentArea.slice(runScrollerStart, listSelectorStart), /visibleResultItems/);
  assert.match(contentArea, /resultAutoSave \? 'bg-primary\/10 text-primary[\s\S]*: 'text-muted-foreground hover:bg-accent hover:text-foreground'/);
  assert.doesNotMatch(contentArea, /queryResultAutoRefresh|QUERY_RESULT_AUTO_REFRESH|nextResultToolbarLayout/);
  assert.equal((contentArea.match(/<QueryResultViewSwitcher\b/g) ?? []).length, 2);
  assert.equal((contentArea.match(/<QueryResultToolbarActions\b/g) ?? []).length, 2);
});

test("appending a result run preserves the tab-strip scroll position", () => {
  const contentArea = source(contentAreaPath);
  const resultRunWatcherStart = contentArea.indexOf("function resultRunIdsWereAppended");
  const resultRunWatcherEnd = contentArea.indexOf("const summaryItems", resultRunWatcherStart);
  const resultRunWatcher = contentArea.slice(resultRunWatcherStart, resultRunWatcherEnd);

  assert.ok(resultRunWatcherStart >= 0);
  assert.match(resultRunWatcher, /current\.length > previous\.length/);
  assert.match(resultRunWatcher, /activeRunId: props\.activeTab\.activeResultRunId/);
  assert.match(resultRunWatcher, /activeRunChanged && !resultRunIdsWereAppended\(previous\.runIds, current\.runIds\)/);
  assert.match(resultRunWatcher, /updateResultTabsAfterRender/);
  assert.match(resultRunWatcher, /revealActiveResultRunAfterRender/);
  assert.match(contentArea, /function focusResultRunByIndex[\s\S]*scrollIntoView/);
  assert.match(contentArea, /async function removeResultRun[\s\S]*scrollIntoView/);
});

test("the close-tab shortcut clears query results before closing the tab", () => {
  const app = source(appPath);
  const closeShortcutStart = app.indexOf("if (isCloseTabShortcut(e, shortcuts))");
  const closeShortcutEnd = app.indexOf("if (isSaveShortcut", closeShortcutStart);
  const closeShortcut = app.slice(closeShortcutStart, closeShortcutEnd);

  assert.ok(closeShortcutStart >= 0);
  assert.ok(closeShortcut.indexOf("await queryStore.clearQueryResults(queryStore.activeTabId)") < closeShortcut.indexOf("queryStore.closeTab(queryStore.activeTabId)"));
});

test("the configurable results pane shortcut only toggles existing output", () => {
  const contentArea = source(contentAreaPath);
  const app = source(appPath);
  const toggleStart = contentArea.indexOf("function toggleResultsPane()");
  const toggleEnd = contentArea.indexOf("function onResultsResized", toggleStart);
  const toggle = contentArea.slice(toggleStart, toggleEnd);
  const shortcutStart = app.indexOf("if (isToggleResultsPaneShortcut(e, shortcuts)");
  const shortcutEnd = app.indexOf("if (isNewQueryShortcut", shortcutStart);
  const shortcut = app.slice(shortcutStart, shortcutEnd);

  assert.ok(toggleStart >= 0);
  assert.match(toggle, /if \(props\.activeTab\.mode !== "query" \|\| !hasQueryOutput\.value\) return false/);
  assert.match(toggle, /resultsPaneOpen\.value = !resultsPaneOpen\.value/);
  assert.match(toggle, /return true/);
  assert.doesNotMatch(toggle, /closeQueryResult|clearQueryResults|closeResultSession/);
  assert.match(contentArea, /defineExpose\(\{[\s\S]*toggleResultsPane/);
  assert.ok(shortcutStart >= 0);
  assert.match(shortcut, /contentAreaRef\.value\?\.toggleResultsPane\(\)/);
  assert.match(shortcut, /e\.preventDefault\(\)/);
  assert.match(shortcut, /e\.stopPropagation\(\)/);
});

test("ContentArea keeps MySQL standard explain results available in the shared toolbar", () => {
  const contentArea = source(contentAreaPath);

  assert.match(contentArea, /canShowExplainOutput = computed\([\s\S]*explainTableResult[\s\S]*explainTableError/);
  assert.match(contentArea, /:table-result="activeTab\.explainTableResult"/);
  assert.match(contentArea, /:table-error="activeTab\.explainTableError"/);
});

test("DataGrid exposes persistent result toolbar slots", () => {
  const dataGrid = source(dataGridPath);

  assert.match(dataGrid, /slots\["result-toolbar-leading"\]/);
  assert.match(dataGrid, /slots\["result-toolbar-actions"\]/);
  assert.match(dataGrid, /<slot name="result-toolbar-leading" :compact="compactDataGridToolbar"/);
  assert.match(dataGrid, /<slot v-if="hasResultToolbarActionsSlot" name="result-toolbar-actions" :compact="compactDataGridToolbar"/);
  assert.match(dataGrid, /hasResultToolbarLeadingSlot\.value \|\|[\s\S]*hasResultToolbarActionsSlot\.value/);
});

test("table-data toolbar refresh keeps page size independent from SQL editor settings", () => {
  const dataGrid = source(dataGridPath);

  // Table-data grids resolve page size through the table-open preference
  // (pageLimit ?? tableOpenPageLimit(tableOpenPageSize)) instead of the SQL editor pageSize.
  assert.match(dataGrid, /pageSizePreference = computed\(\(\) => resolveDataGridPageSizePreference\(props\.context, props\.pageSizePreference\)\)/);
  assert.match(dataGrid, /pageSize = ref\(preferredDataGridPageSize\(settingsStore\.editorSettings, pageSizePreference\.value, props\.pageLimit\)\)/);
  assert.match(dataGrid, /watch\([\s\S]*\(\) => settingsStore\.editorSettings\.pageSize,[\s\S]*if \(pageSizePreference\.value !== "results"\) return;[\s\S]*pageSize\.value = normalizeResultPageSize\(value, pageSize\.value\)/);
  assert.match(dataGrid, /settingsStore\.updateEditorSettings\(dataGridPageSizeSettingsPatch\(pageSizePreference\.value, normalizedSize\)\)/);
  assert.match(dataGrid, /const resetToFirstPage = hasPendingConditionInputs\(\);/);
  assert.match(dataGrid, /emit\("reload", props\.sql, searchText\.value, currentWhereInput\(\), currentOrderBy\(\), pageSize\.value, resetToFirstPage \? 0 : \(currentPage\.value - 1\) \* pageSize\.value, "refresh"\)/);
});

test("standalone result views use the same compact toolbar breakpoint", () => {
  const contentArea = source(contentAreaPath);
  const dataGrid = source(dataGridPath);

  assert.match(contentArea, /ref="standaloneResultToolbarRef"/);
  assert.match(contentArea, /isDataGridToolbarCompact\(standaloneResultToolbarWidth\.value, standaloneResultToolbarViewportWidth\.value\)/);
  assert.equal((contentArea.match(/:compact="standaloneResultToolbarCompact"/g) ?? []).length, 2);
  assert.match(dataGrid, /isDataGridToolbarCompact\(dataGridTopbarWidth\.value, dataGridViewportWidth\.value, DATA_GRID_CONDITION_TOOLBAR_MIN_WIDTH\)/);
});

test("embedded and standalone result toolbars share the same fixed height", () => {
  const contentArea = source(contentAreaPath);
  const dataGrid = source(dataGridPath);
  const standaloneClasses = contentArea.match(/ref="standaloneResultToolbarRef" class="([^"]+)"/)?.[1].split(/\s+/) ?? [];
  const embeddedClasses = dataGrid.match(/ref="dataGridTopbarRef"[^>]+class="([^"]+)"/)?.[1].split(/\s+/) ?? [];

  assert.ok(standaloneClasses.includes("h-8"));
  assert.ok(embeddedClasses.includes("h-8"));
  assert.ok(standaloneClasses.includes("items-center"));
  assert.ok(embeddedClasses.includes("items-center"));
  assert.ok(!standaloneClasses.includes("h-7"));
  assert.ok(!embeddedClasses.includes("h-7"));
  assert.ok(!standaloneClasses.includes("min-h-7"));
  assert.ok(!embeddedClasses.includes("min-h-7"));
});

test("embedded result toolbar cannot scroll vertically", () => {
  const dataGrid = source(dataGridPath);
  const scrollClasses = dataGrid.match(/class="data-grid-topbar-scroll ([^"]+)"/)?.[1].split(/\s+/) ?? [];

  assert.ok(scrollClasses.includes("overflow-clip"));
  assert.ok(!scrollClasses.some((className) => className.startsWith("overflow-x-")));
  assert.ok(!scrollClasses.some((className) => className.startsWith("overflow-y-")));
});

test("DataGrid marks toolbar refresh separately from current-result reloads", () => {
  const dataGrid = source(dataGridPath);

  assert.match(dataGrid, /emit\("reload", props\.sql,[^;]+"refresh"\);/);
  assert.match(dataGrid, /function onToolbarRollback\(\)[\s\S]*?emit\("reload", props\.sql,[^;]+\);/);
});

test("Elasticsearch JSON refresh preserves multi-result query groups", () => {
  const contentArea = source(contentAreaPath);

  assert.match(contentArea, /if \(activeElasticsearchJsonResponse\.value\) \{[\s\S]*?emit\("reload", activeResultSql\.value, undefined, undefined, undefined, undefined, undefined, "refresh"\);/);
});
