import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

function functionBody(source: string, name: string): string {
  const signature = `function ${name}(`;
  const asyncSignature = `async ${signature}`;
  const signatureIndex = source.indexOf(asyncSignature) >= 0 ? source.indexOf(asyncSignature) : source.indexOf(signature);
  assert.notEqual(signatureIndex, -1, `Could not find function ${name}`);
  const bodyStart = source.indexOf("{", signatureIndex);
  assert.notEqual(bodyStart, -1, `Could not find body for ${name}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, index);
    }
  }
  throw new Error(`Could not parse body for ${name}`);
}

test("tree-level context menu opens with the current row items atomically", () => {
  const connectionTree = readFileSync("apps/desktop/src/components/sidebar/ConnectionTree.vue", "utf8");
  const contextMenu = readFileSync("apps/desktop/src/components/ui/CustomContextMenu.vue", "utf8");

  assert.match(connectionTree, /openContextMenu\(event, items\)/);
  assert.match(connectionTree, /sidebarContextMenuRef\.value\?\.close\(\)/);
  assert.match(connectionTree, /sidebarContextMenuTarget\.value = createSidebarActionTarget\(node\)/);
  assert.match(connectionTree, /sidebarContextMenuTarget\.value = null/);
  assert.match(connectionTree, /<CustomContextMenu ref="sidebarContextMenuRef"/);
  assert.match(contextMenu, /function onContextMenu\(event: MouseEvent, itemsOverride\?: ContextMenuItem\[\]\)/);
  assert.match(contextMenu, /const items = itemsOverride \?\?/);
  assert.match(contextMenu, /defineExpose\(\{ close, menuRef, subRef \}\)/);
});

test("rare sidebar dialogs share module-level async wrappers with fallbacks", () => {
  const treeItem = readFileSync("apps/desktop/src/components/sidebar/TreeItem.vue", "utf8");
  const asyncDialogs = readFileSync("apps/desktop/src/components/sidebar/sidebarAsyncDialogs.ts", "utf8");

  assert.doesNotMatch(treeItem, /defineAsyncComponent/);
  assert.match(asyncDialogs, /loadingComponent: SidebarAsyncDialogLoading/);
  assert.match(asyncDialogs, /errorComponent: SidebarAsyncDialogError/);
  assert.match(asyncDialogs, /timeout: 15_000/);
});

test("tree host owns sidebar data-open generations", () => {
  const treeItem = readFileSync("apps/desktop/src/components/sidebar/TreeItem.vue", "utf8");
  const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
  const connectionTree = readFileSync("apps/desktop/src/components/sidebar/ConnectionTree.vue", "utf8");

  assert.doesNotMatch(treeItem, /runSidebarDataOpenImmediately/);
  assert.doesNotMatch(treeItem, /emit\("open-data"/);
  assert.match(runtimeHost, /emit\("open-data", node, true, "default", openData\)/);
  assert.match(connectionTree, /<SidebarTreeRuntimeHost/);
  assert.match(connectionTree, /function openSidebarData/);
  assert.match(connectionTree, /runSidebarDataOpenImmediately/);
  assert.match(connectionTree, /createSidebarActionTarget\(node\)/);
});

test("query-tab object source opens clean isolated tabs and honors backend editability", () => {
  const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
  const openObjectSourceBody = functionBody(runtimeHost, "openObjectSourceDialog");

  assert.match(openObjectSourceBody, /createTab\(connectionId, database, `Source - \$\{node\.label\}`, "query", schema, editableSource, node\.catalog, \{ forceNew: true \}\)/);
  assert.match(openObjectSourceBody, /raw\.editable !== false/);
  assert.match(openObjectSourceBody, /!\["SEQUENCE", "TRIGGER", "TYPE", "TYPE_BODY"\]\.includes\(resolvedType\)/);
  assert.match(openObjectSourceBody, /signature: node\.signature/);
  assert.doesNotMatch(openObjectSourceBody, /queryStore\.updateSql/);
});

test("table copy menu uses the shared single and multi-selection clipboard path", () => {
  const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
  const copyNameBody = functionBody(runtimeHost, "copyName");
  const copySelectedNamesBody = functionBody(runtimeHost, "copySelectedNames");
  const clipboardMenuBody = functionBody(runtimeHost, "treeTableClipboardMenuItems");

  assert.match(clipboardMenuBody, /tableClipboardMenuState\(\s*normalizedTreeClipboardTableEntries\(\)/);
  assert.match(clipboardMenuBody, /state === "paste" \? \[pasteItem\] : \[copyItem, pasteItem\]/);
  assert.match(runtimeHost, /items\.push\(\.\.\.treeTableClipboardMenuItems\(node\)\)/);
  assert.doesNotMatch(runtimeHost, /function copyTableToClipboard\(/);
  assert.doesNotMatch(copyNameBody, /updateTreeClipboardForNodes/);
  assert.match(copySelectedNamesBody, /const selectedNodes = selectedTreeNodesInVisibleOrder\(\)/);
  assert.match(copySelectedNamesBody, /selectedNodes\.length > 1 && selectedNodes\.some\(\(node\) => node\.id === activeNode\.value\.id\) \? selectedNodes : \[activeNode\.value\]/);
  assert.match(copySelectedNamesBody, /updateTreeClipboardForNodes\(nodes\)/);
  assert.match(copySelectedNamesBody, /copyToClipboard\(nodes\.map\(copyNameForTreeNode\)\.join\("\\n"\)\)/);
});

test("successful tree table paste consumes only the clipboard used to start it", () => {
  const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
  const confirmPasteTableBody = functionBody(runtimeHost, "confirmPasteTable");

  assert.match(confirmPasteTableBody, /const clipboardAtPasteStart = connectionStore\.treeClipboard/);
  assert.match(confirmPasteTableBody, /if \(pasteFailCount === 0\)/);
  assert.match(confirmPasteTableBody, /connectionStore\.treeClipboard === clipboardAtPasteStart/);
  assert.match(confirmPasteTableBody, /connectionStore\.treeClipboard = null/);
});

test("tree table paste keeps the clipboard when production confirmation is cancelled", () => {
  const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
  const confirmPasteTableBody = functionBody(runtimeHost, "confirmPasteTable");

  assert.match(confirmPasteTableBody, /const structureExecuted = await executeTreeNodeSqlWithProductionGuard[\s\S]*?if \(!structureExecuted\) \{[\s\S]*?pasteCancelled = true;[\s\S]*?break;/);
  assert.match(confirmPasteTableBody, /const dataExecuted = await executeTreeNodeSqlWithProductionGuard[\s\S]*?if \(!dataExecuted\) \{[\s\S]*?pasteCancelled = true;[\s\S]*?break;/);
  assert.match(confirmPasteTableBody, /queueRefreshTarget\(entry\)/);
  assert.match(confirmPasteTableBody, /if \(pasteCancelled\) \{[\s\S]*?if \(hasMutatedTable && refreshFailCount === 0\)[\s\S]*?pasteTableCancelledAfterPartial[\s\S]*?return;/);
});

test("tree table paste consumes the clipboard even if only the object-list refresh fails", () => {
  const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
  const confirmPasteTableBody = functionBody(runtimeHost, "confirmPasteTable");

  assert.match(confirmPasteTableBody, /let pasteFailCount = 0/);
  assert.match(confirmPasteTableBody, /let refreshFailCount = 0/);
  assert.match(confirmPasteTableBody, /pasteFailCount\+\+/);
  assert.match(confirmPasteTableBody, /refreshFailCount\+\+/);
  assert.match(confirmPasteTableBody, /if \(pasteFailCount === 0\)[\s\S]*?connectionStore\.treeClipboard = null/);
  assert.match(confirmPasteTableBody, /if \(refreshFailCount > 0\)[\s\S]*?pasteTableRefreshFailed/);
});

test("sidebar keyboard table copy uses the same normalized schema as the context menu", () => {
  const connectionTree = readFileSync("apps/desktop/src/components/sidebar/ConnectionTree.vue", "utf8");
  const copySelectedSidebarNamesBody = functionBody(connectionTree, "copySelectedSidebarNames");

  assert.match(copySelectedSidebarNamesBody, /schema: connectionObjectTreeNodeSchema\(store\.getConfig\(node\.connectionId!\), node\.database!, node\.schema\)/);
});

test("batch table paste refreshes each object list after all tables are processed", () => {
  const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
  const confirmPasteTableBody = functionBody(runtimeHost, "confirmPasteTable");
  const pasteLoopIndex = confirmPasteTableBody.indexOf("for (const entry of entries)");
  const refreshLoopIndex = confirmPasteTableBody.indexOf("for (const refreshTarget of refreshTargets.values())");

  assert.notEqual(pasteLoopIndex, -1);
  assert.notEqual(refreshLoopIndex, -1);
  assert.ok(refreshLoopIndex > pasteLoopIndex, "object-list refresh must run after the table paste loop");
  assert.doesNotMatch(confirmPasteTableBody.slice(pasteLoopIndex, refreshLoopIndex), /refreshObjectListTreeNode/);
  assert.match(confirmPasteTableBody.slice(refreshLoopIndex), /refreshObjectListTreeNode\(refreshTarget\.connectionId, refreshTarget\.database, refreshTarget\.schema\)/);
});
