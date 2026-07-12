import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc";

const contentAreaPath = "apps/desktop/src/components/layout/ContentArea.vue";
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

test("query result toolbar reuses the production icon contract", () => {
  const contentArea = source(contentAreaPath);
  const viewSwitcher = source(viewSwitcherPath);
  const toolbarActions = source(toolbarActionsPath);

  assert.match(contentArea, /<Pin class="h-3\.5 w-3\.5"/);
  assert.match(contentArea, /<Wrench class="h-4 w-4"/);
  assert.match(contentArea, /<ChevronDown class="h-3\.5 w-3\.5"/);
  assert.match(viewSwitcher, /import \{ BarChart3, ListChecks \} from "@lucide\/vue"/);
  assert.match(toolbarActions, /import \{ GitBranch, Loader2, Upload \} from "@lucide\/vue"/);
  assert.match(viewSwitcher, /inline-flex h-4 items-center leading-none/);
  assert.match(toolbarActions, /block h-3\.5 w-3\.5 self-center/);
  assert.doesNotMatch(viewSwitcher + toolbarActions, /<svg\b|<symbol\b|<use\b/);
});

test("ContentArea keeps result history conditional and removes duplicate refresh state", () => {
  const contentArea = source(contentAreaPath);

  assert.match(contentArea, /showResultRunSelector = computed\(\(\) => resultAutoSave\.value && resultRuns\.value\.length > 0\)/);
  assert.match(contentArea, /<template v-if="showResultRunSelector">/);
  assert.match(contentArea, /resultAutoSave \? 'bg-primary\/10 text-primary[\s\S]*: 'text-muted-foreground hover:bg-accent hover:text-foreground'/);
  assert.doesNotMatch(contentArea, /queryResultAutoRefresh|QUERY_RESULT_AUTO_REFRESH|nextResultToolbarLayout/);
  assert.equal((contentArea.match(/<QueryResultViewSwitcher\b/g) ?? []).length, 2);
  assert.equal((contentArea.match(/<QueryResultToolbarActions\b/g) ?? []).length, 2);
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

test("standalone result views use the same compact toolbar breakpoint", () => {
  const contentArea = source(contentAreaPath);
  const dataGrid = source(dataGridPath);

  assert.match(contentArea, /ref="standaloneResultToolbarRef"/);
  assert.match(contentArea, /standaloneResultToolbarWidth\.value < DATA_GRID_COMPACT_TOPBAR_WIDTH/);
  assert.equal((contentArea.match(/:compact="standaloneResultToolbarCompact"/g) ?? []).length, 2);
  assert.match(dataGrid, /dataGridTopbarWidth\.value < DATA_GRID_COMPACT_TOPBAR_WIDTH/);
});

test("DataGrid marks toolbar refresh separately from current-result reloads", () => {
  const dataGrid = source(dataGridPath);

  assert.match(dataGrid, /emit\("reload", props\.sql,[^;]+"refresh"\);/);
  assert.match(dataGrid, /function onToolbarRollback\(\)[\s\S]*?emit\("reload", props\.sql,[^;]+\);/);
});

test("Elasticsearch JSON refresh preserves multi-result query groups", () => {
  const contentArea = source(contentAreaPath);

  assert.match(
    contentArea,
    /if \(activeElasticsearchJsonResponse\.value\) \{[\s\S]*?emit\("reload", activeResultSql\.value, undefined, undefined, undefined, undefined, undefined, "refresh"\);/,
  );
});
