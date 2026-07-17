import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const treeItem = readFileSync("apps/desktop/src/components/sidebar/TreeItem.vue", "utf8");
const connectionTree = readFileSync("apps/desktop/src/components/sidebar/ConnectionTree.vue", "utf8");
const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
const dataOpenRuntime = readFileSync("apps/desktop/src/composables/useSidebarDataOpenRuntime.ts", "utf8");

function occurrences(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

test("sidebar rows stay within the hot-path source budget", () => {
  assert.ok(treeItem.split("\n").length <= 2_200, "TreeItem must stay below 2,200 lines");
  assert.ok(occurrences(treeItem, /^(?:async )?function /gm) <= 90, "TreeItem must stay below 90 top-level functions");
  assert.ok(occurrences(treeItem, /^const [A-Za-z0-9_]+ = computed\(/gm) <= 25, "TreeItem must stay below 25 computed values");
  assert.doesNotMatch(treeItem, /ContextMenuItem|emit\("open-data"|getTreeItemDialogController|executeWithProductionSqlGuard/);
});

test("one tree-level runtime serves every row renderer", () => {
  assert.equal(occurrences(connectionTree, /<SidebarTreeRuntimeHost\b/g), 1);
  assert.equal(occurrences(connectionTree, /provide\(sidebarTreeRuntimeKey, sidebarTreeRuntime\)/g), 1);
  assert.match(connectionTree, /sidebarTreeRuntime\.buildContextMenu\(node\)/);
  assert.match(runtimeHost, /<template \/>/);
  assert.match(runtimeHost, /function bindMenuTarget\(/);
  assert.match(runtimeHost, /function activateActionTarget\(/);
  assert.match(runtimeHost, /useSidebarDataOpenRuntime\(\)/);
  assert.doesNotMatch(runtimeHost, /async function openData\(/);
  assert.match(dataOpenRuntime, /async function openData\(/);
  assert.match(dataOpenRuntime, /findExistingDataTabCandidate/);
  assert.match(dataOpenRuntime, /loadTableMetadata/);
  assert.match(dataOpenRuntime, /canApplyDataTabMetadata/);
});

test("the persistent runtime releases detached tree nodes", () => {
  const actionTarget = readFileSync("apps/desktop/src/lib/sidebar/sidebarActionTarget.ts", "utf8");
  const connectionMutationRuntime = readFileSync("apps/desktop/src/composables/useSidebarConnectionMutationRuntime.ts", "utf8");
  const tableMutationRuntime = readFileSync("apps/desktop/src/composables/useSidebarTableMutationRuntime.ts", "utf8");

  assert.match(actionTarget, /function releaseRemovedSidebarActionTarget/);
  assert.match(actionTarget, /children: undefined, hiddenChildren: undefined/);
  assert.match(runtimeHost, /\(\) => connectionStore\.treeNodes/);
  assert.match(runtimeHost, /findSidebarActionTarget\(nodes, createSidebarActionTarget\(activeNode\.value\)\)/);
  assert.match(connectionMutationRuntime, /releaseActiveNodeReference\(targets\.map\(\(target\) => target\.id\)\)/);
  assert.match(tableMutationRuntime, /releaseActiveNodeReference\(\[node\.id\]\)/);
});
