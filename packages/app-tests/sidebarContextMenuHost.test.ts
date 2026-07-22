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
  assert.match(contextMenu, /defineExpose\(\{ close \}\)/);
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

test("table copy menu uses the shared single and multi-selection clipboard path", () => {
  const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
  const copySelectedNamesBody = functionBody(runtimeHost, "copySelectedNames");

  assert.match(runtimeHost, /label: t\("contextMenu\.copyTable"\), action: copySelectedNames, icon: Copy/);
  assert.doesNotMatch(runtimeHost, /function copyTableToClipboard\(/);
  assert.match(copySelectedNamesBody, /const selectedNodes = selectedTreeNodesInVisibleOrder\(\)/);
  assert.match(copySelectedNamesBody, /selectedNodes\.length > 1 && selectedNodes\.some\(\(node\) => node\.id === activeNode\.value\.id\) \? selectedNodes : \[activeNode\.value\]/);
  assert.match(copySelectedNamesBody, /updateTreeClipboardForNodes\(nodes\)/);
  assert.match(copySelectedNamesBody, /copyToClipboard\(nodes\.map\(copyNameForTreeNode\)\.join\("\\n"\)\)/);
});
