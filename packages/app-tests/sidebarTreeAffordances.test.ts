import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { syncSidebarTreeNodeExpansion } from "../../apps/desktop/src/lib/sidebar/sidebarTreeExpansion.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";

const treeItem = readFileSync("apps/desktop/src/components/sidebar/TreeItem.vue", "utf8");
const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
const connectionTree = readFileSync("apps/desktop/src/components/sidebar/ConnectionTree.vue", "utf8");
const connectionStore = readFileSync("apps/desktop/src/stores/connectionStore.ts", "utf8");

test("sidebar rows retain database-specific node affordances", () => {
  for (const nodeType of ["connection", "database", "schema", "table", "column", "mongo-db", "mongo-collection", "redis-db", "nacos-namespace", "mq-tenant"]) {
    const sources = `${treeItem}\n${runtimeHost}`;
    assert.ok(sources.includes(`node.type === "${nodeType}"`) || sources.includes(`node.type === '${nodeType}'`), nodeType);
  }
  assert.match(treeItem, /@dblclick="onDoubleClick"/);
  assert.match(treeItem, /@keydown="onKeydown"/);
  assert.match(treeItem, /@mousedown="onRowMouseDown"/);
  assert.match(treeItem, /@contextmenu="onTreeItemContextMenu"/);
});

test("complex tree changes retain the full rebuild fallback", () => {
  assert.match(connectionTree, /const filteredNodes = computed/);
  assert.match(connectionTree, /filterSidebarTree\(/);
  assert.match(connectionTree, /const flatNodes = computed<FlatTreeNode\[]>/);
  assert.match(connectionTree, /flattenTree\(filteredNodes\.value\)/);
  assert.match(connectionTree, /watch\(flatNodes,/);
  assert.doesNotMatch(connectionTree, /treeScrollerRef\.value\?\.(?:forceUpdate|updateVisibleItems)/);
  assert.match(connectionTree, /@node-toggled="onNodeToggled"/);
});

test("tree toggles synchronize filtered node clones with the live sidebar tree", () => {
  const liveConnection: TreeNode = {
    id: "connection-1",
    label: "Connection 1",
    type: "connection",
    connectionId: "connection-1",
    isExpanded: true,
  };
  const renderedClone: TreeNode = { ...liveConnection, isExpanded: false };

  assert.equal(syncSidebarTreeNodeExpansion([liveConnection], renderedClone), true);
  assert.equal(liveConnection.isExpanded, false);
  assert.equal(syncSidebarTreeNodeExpansion([liveConnection], liveConnection), false);
});

test("tree rebuilds keep a context menu only while its target row remains visible", () => {
  assert.match(connectionTree, /nodes\.find\(\(\{ node \}\) => matchesSidebarActionTarget\(node, contextMenuTarget\)\)\?\.node/);
  assert.match(connectionTree, /if \(!visibleContextMenuTarget \|\| visibleContextMenuTarget\.valid === false\)/);
});

test("programmable object groups use the shared metadata loader", () => {
  assert.match(runtimeHost, /const databaseObjectGroup = !!objectTypesForGroupNode\(node\.type\)/);
  assert.match(connectionStore, /else if \(objectTypesForGroupNode\(node\.type\)\) \{\s*await loadObjectGroupChildren\(node, options\);/);
});
