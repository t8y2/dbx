import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const connectionTree = readFileSync("apps/desktop/src/components/sidebar/ConnectionTree.vue", "utf8");
const treeItem = readFileSync("apps/desktop/src/components/sidebar/TreeItem.vue", "utf8");
const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
const dialogHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeItemDialogs.vue", "utf8");
const dialogState = readFileSync("apps/desktop/src/components/sidebar/sidebarTreeDialogState.ts", "utf8");
const visibleDatabasesDialog = readFileSync("apps/desktop/src/components/sidebar/VisibleDatabasesDialog.vue", "utf8");
const visibleSchemasDialog = readFileSync("apps/desktop/src/components/sidebar/VisibleSchemasDialog.vue", "utf8");

function occurrences(source: string, value: string): number {
  return source.split(value).length - 1;
}

test("sidebar routes destructive confirmations through one tree-level host", () => {
  assert.match(runtimeHost, /emit\("open-danger-dialog", route\.createRequest\(\)\)/);
  assert.match(connectionTree, /function openSidebarDangerDialog\(request: SidebarDangerDialogRequest\)/);
  assert.equal(occurrences(connectionTree, "<SidebarDangerConfirmDialog"), 1);
  assert.doesNotMatch(treeItem, /<DangerConfirmDialog/);
});

test("tree-level danger routing preserves cancel and close-on-confirm behavior", () => {
  assert.match(connectionTree, /v-model:open="sidebarDangerDialogOpen"/);
  assert.match(connectionTree, /if \(request\.closeOnConfirm !== false\) sidebarDangerDialogOpen\.value = false/);
  assert.match(connectionTree, /await request\.confirm\(\)/);
  assert.match(connectionTree, /sidebarDangerDialogOpen\.value = false/);
  assert.match(connectionTree, /sidebarDangerDialogConfirming\.value = false/);
});

test("remaining form dialogs render once at tree level and keep confirm/cancel bindings", () => {
  assert.equal(occurrences(connectionTree, "<SidebarTreeItemDialogs"), 1);
  assert.doesNotMatch(treeItem, /<Dialog(?:\s|>)/);
  assert.doesNotMatch(treeItem, /<InstallExtensionDialog/);
  assert.match(dialogHost, /v-model:open="showCreateDatabaseDialog"/);
  assert.match(dialogHost, /@click="showCreateDatabaseDialog = false"/);
  assert.match(dialogHost, /@click="confirmCreateDatabase"/);
  assert.match(dialogHost, /v-model:open="showPasteDialog"/);
  assert.match(dialogHost, /@click="confirmPasteTable"/);
});

test("dialog controller routing preserves shared open-flag refs instead of spreading them", () => {
  assert.match(runtimeHost, /createRoutedSidebarDialogController\(/);
  assert.doesNotMatch(runtimeHost, /reactive<Record<string, any>>\(\{ \.\.\.controller/);
});

test("saved object dialogs refresh the immutable active target", () => {
  assert.match(connectionTree, /<SidebarObjectSourceDialog[\s\S]*?@saved="refreshSidebarActionTarget"/);
  assert.match(connectionTree, /<InstallExtensionDialog[\s\S]*?@close="refreshSidebarActionTarget"/);
  assert.match(connectionTree, /findSidebarActionTarget\(store\.treeNodes, target\)/);
});

test("lazy visible object dialogs load when first mounted open", () => {
  assert.match(visibleDatabasesDialog, /watch\([\s\S]*?loadDatabases\(\)[\s\S]*?\{ immediate: true \}/);
  assert.match(visibleSchemasDialog, /watch\([\s\S]*?loadSchemas\(\)[\s\S]*?\{ immediate: true \}/);
});

test("shared dialog state is owner-gated and confirm handlers use snapshots", () => {
  assert.match(dialogState, /export const sidebarTreeDialogOwner = shallowRef<symbol \| null>\(null\)/);
  assert.match(dialogState, /export const sidebarDangerTarget = shallowRef<TreeNode \| null>\(null\)/);
  assert.match(dialogState, /export const sidebarFormTarget = shallowRef<TreeNode \| null>\(null\)/);
  assert.match(runtimeHost, /sidebarTreeDialogOwner\.value !== treeItemDialogOwner/);
  assert.match(runtimeHost, /const node = sidebarDangerTarget\.value \?\? activeNode\.value/);
  assert.match(runtimeHost, /const node = sidebarFormTarget\.value \?\? activeNode\.value/);
  assert.match(runtimeHost, /batchDropTargets\.value = targets\.slice\(\)/);
  assert.match(runtimeHost, /batchTruncateTargets\.value = targets\.slice\(\)/);
  assert.match(runtimeHost, /activateActionTarget\(target\)/);
});
