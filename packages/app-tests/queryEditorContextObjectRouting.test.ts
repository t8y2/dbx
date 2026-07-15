import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const queryEditor = readFileSync("apps/desktop/src/components/editor/QueryEditor.vue", "utf8");
const contentArea = readFileSync("apps/desktop/src/components/layout/ContentArea.vue", "utf8");
const app = readFileSync("apps/desktop/src/App.vue", "utf8");

test("query editor routes relation-aware context-menu targets through ContentArea", () => {
  assert.match(queryEditor, /viewTableData: \[target: SqlObjectNavigationTarget\]/);
  assert.match(queryEditor, /openObjectSource: \[target: SqlObjectNavigationTarget, initialEditing: boolean\]/);
  assert.match(queryEditor, /queryContextObjectActions\(contextObjectTarget\.value\?\.type\)\.map\(contextObjectMenuItem\)/);
  assert.match(contentArea, /openObjectSource: \[target: SqlObjectNavigationTarget, initialEditing: boolean\]/);
  assert.match(contentArea, /@open-object-source="onHandleOpenObjectSource"/);
  assert.match(app, /@open-object-source="onOpenObjectSource"/);
});

test("App keeps view-like targets out of table structure editing and forwards their source kind", () => {
  assert.match(app, /if \(typeof table !== "string"\) \{[\s\S]*?tableName: table\.name,[\s\S]*?tableType: table\.type \? sqlObjectNavigationTableType\(table\) : undefined/);
  assert.match(app, /if \(!target \|\| sqlObjectNavigationSourceKind\(table\)\) return;\s*queryStore\.openTableStructure/);
  assert.match(app, /queryEditorDdlTarget\.value = \{ \.\.\.target, objectType: sqlObjectNavigationSourceKind\(table\) \}/);
  assert.match(app, /<QueryEditorObjectSourceDialog[\s\S]*?:object-type="queryEditorObjectSourceTarget\.objectType"[\s\S]*?:initial-editing="queryEditorObjectSourceTarget\.initialEditing"/);
  assert.match(app, /@saved="onQueryEditorObjectSourceSaved"/);
  assert.match(app, /invalidateCompletionCache\(target\.connectionId, target\.database\);\s*contentAreaRef\.value\?\.refreshQueryEditorCompletionCache\(\)/);
  assert.match(contentArea, /defineExpose\(\{[\s\S]*?refreshQueryEditorCompletionCache/);
});
